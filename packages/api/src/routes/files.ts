import { Router, type Request, type Response } from "express";
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, extname, relative, resolve, sep } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";
import { findProject } from "../lib/projects.js";

/**
 * The files of the project a chat works in, for the web chat's file explorer: list, read, and save. Paths are
 * relative to the chat's own folder (its worktree once it has one) and can never leave it, symlinks included.
 */

const MAX_TEXT = 1024 * 1024;
const MAX_RAW = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const HIDDEN = new Set([".git"]);
const RAW_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
};

// The server view (the whole home folder) hides credential stores and env files: agents still reach them, a stray click in a browser tab should not.
const SECRET_PATHS = [
  ".ssh", ".gnupg", ".aws", ".netrc", ".config/opa", ".config/op", ".config/gh", ".docker/config.json",
  ".codex/auth.json", ".claude/.credentials.json", ".claude.json", ".gemini", ".doppler", ".cloudflared",
  ".browser-profiles", ".agent-browser-states", "snap/chromium/common/browser-profiles",
];
const isEnvFile = (name: string) => name === ".env" || name.startsWith(".env.");

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The folder files resolve against. A chat edits its worktree if it has one, else its project; browsing never creates
 * a worktree. A chat not started yet (only a project picked) is read-only, so nobody edits the shared main checkout by accident.
 */
function fileRoot(query: Record<string, unknown>): { root: string; writable: boolean; server?: true } {
  if (query.scope === "server") return { root: homedir(), writable: true, server: true };
  if (typeof query.conversation === "string" && query.conversation) {
    const row = db.select().from(conversations).where(eq(conversations.id, query.conversation)).get();
    if (!row?.projectPath) throw new HttpError(404, "This chat has no project");
    const root = row.worktreePath && existsSync(row.worktreePath) ? row.worktreePath : row.projectPath;
    return { root, writable: true };
  }
  const project = typeof query.project === "string" ? findProject(query.project) : undefined;
  if (!project) throw new HttpError(404, "No such project");
  return { root: project.path, writable: false };
}

/** The absolute path of `rel` inside `root`. Refuses anything that resolves outside, through `..` or a symlink. */
export function insideRoot(root: string, rel: string): string {
  const realRoot = realpathSync(root);
  const full = resolve(realRoot, rel || ".");
  if (!existsSync(full)) throw new HttpError(404, `Not found: ${rel}`);
  const real = realpathSync(full);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new HttpError(403, "That path is outside the project");
  return real;
}

/** Whether the server view must hide `real`: a credential store or an env file under the home folder. */
export function isSecretPath(home: string, real: string): boolean {
  const rel = relative(home, real);
  return isEnvFile(basename(real)) || SECRET_PATHS.some((secret) => rel === secret || rel.startsWith(secret + sep));
}

/** The file or folder a request names, refused when the server view must hide it. */
function target(scope: { root: string; server?: true }, rel: string): string {
  const real = insideRoot(scope.root, rel);
  if (scope.server && isSecretPath(realpathSync(scope.root), real)) throw new HttpError(403, "Credentials and env files are not shown here");
  return real;
}

/** The server view names files by absolute path, so "Add to chat" hands any agent a path it can open; a project names them from its root. */
function shownPath(scope: { root: string; server?: true }, real: string): string {
  return scope.server ? real : relative(realpathSync(scope.root), real);
}

/** A NUL byte in the first 8 KB is the usual sign of a binary file. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) res.status(err.status).json({ error: err.message });
      else res.status(500).json({ error: err instanceof Error ? err.message : "File operation failed" });
    }
  };
}

const router: ReturnType<typeof Router> = Router();

// GET /api/files/list?conversation=<id>|project=<path>|scope=server&path=<dir>
router.get("/list", handle((req, res) => {
  const scope = fileRoot(req.query);
  const { root, writable } = scope;
  const dir = target(scope, String(req.query.path ?? ""));
  const realRoot = realpathSync(root);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !HIDDEN.has(entry.name) && !(scope.server && isSecretPath(realRoot, resolve(dir, entry.name))))
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const full = resolve(dir, entry.name);
      // A symlink shows as what it points to; opening one that leaves the project is refused on open.
      const stat = entry.isSymbolicLink() ? (existsSync(full) ? statSync(full) : null) : null;
      const isDir = stat ? stat.isDirectory() : entry.isDirectory();
      return { name: entry.name, path: shownPath(scope, full), type: isDir ? "dir" : "file", ...(isDir ? {} : { size: (stat ?? statSync(full, { throwIfNoEntry: false }))?.size ?? 0 }) };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  res.json({ root: realRoot, writable, path: shownPath(scope, dir), entries });
}));

// GET /api/files/read?…&path=<file>: text up to 1 MB, otherwise only what it is
router.get("/read", handle((req, res) => {
  const scope = fileRoot(req.query);
  const file = target(scope, String(req.query.path ?? ""));
  const stat = statSync(file);
  if (stat.isDirectory()) throw new HttpError(400, "That is a folder");
  const writable = scope.writable;
  const base = { path: shownPath(scope, file), size: stat.size, mtimeMs: stat.mtimeMs, writable };
  if (stat.size > MAX_TEXT) return void res.json({ ...base, kind: "large" });
  const buffer = readFileSync(file);
  if (looksBinary(buffer)) return void res.json({ ...base, kind: "binary" });
  res.json({ ...base, kind: "text", content: buffer.toString("utf-8") });
}));

// GET /api/files/raw?…&path=<file>: images and PDFs, as themselves
router.get("/raw", handle((req, res) => {
  const file = target(fileRoot(req.query), String(req.query.path ?? ""));
  const type = RAW_TYPES[extname(file).toLowerCase()];
  if (!type) throw new HttpError(415, "Only images and PDFs are served raw");
  if (statSync(file).size > MAX_RAW) throw new HttpError(413, "File too large");
  // An SVG can carry script; the sandbox keeps it from running with Chomp's origin if opened directly.
  res.setHeader("Content-Security-Policy", "sandbox");
  res.type(type).send(readFileSync(file));
}));

const MAX_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchHit { path: string; line?: number; text?: string }

/**
 * ripgrep over `dir`: matching lines, or with `names` the files whose path contains the query. The query is literal,
 * case-insensitive unless it has a capital, and comes after `--`, so it can never be read as an option. ripgrep skips
 * hidden files and whatever .gitignore lists; `keep` drops anything else the caller must not show.
 */
export function ripgrep(dir: string, query: string, names: boolean, keep: (path: string) => boolean): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const args = names
    ? ["--files", "--color", "never", "--", dir]
    : ["--json", "--fixed-strings", "--smart-case", "--max-count", "5", "--max-filesize", "1M", "--max-columns", "300", "--max-columns-preview", "--", query, dir];
  const needle = query.toLowerCase();
  return new Promise((resolvePromise, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "ignore"] });
    const hits: SearchHit[] = [];
    let truncated = false;
    let rest = "";
    const finish = () => {
      clearTimeout(timer);
      resolvePromise({ hits, truncated });
    };
    const stop = () => {
      truncated = true;
      child.kill();
    };
    const timer = setTimeout(stop, SEARCH_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf-8")).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (hits.length >= MAX_RESULTS) return stop();
        if (names) {
          if (line && relative(dir, line).toLowerCase().includes(needle) && keep(line)) hits.push({ path: line });
          continue;
        }
        if (!line.startsWith('{"type":"match"')) continue;
        const { data } = JSON.parse(line) as { data: { path: { text?: string }; line_number: number; lines: { text?: string } } };
        const path = data.path.text;
        if (path && keep(path)) hits.push({ path, line: data.line_number, text: (data.lines.text ?? "").replace(/\n$/, "") });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", finish);
  });
}

// GET /api/files/search?…&q=<text>&mode=text|names
router.get("/search", async (req: Request, res: Response) => {
  try {
    const query = String(req.query.q ?? "");
    if (!query.trim() || query.length > 200) throw new HttpError(400, "Search for 1 to 200 characters");
    const scope = fileRoot(req.query);
    const realRoot = realpathSync(scope.root);
    const dir = target(scope, String(req.query.path ?? ""));
    const keep = (path: string) => !scope.server || !isSecretPath(realRoot, path);
    const { hits, truncated } = await ripgrep(dir, query, req.query.mode === "names", keep);
    res.json({ truncated, hits: hits.map((hit) => ({ ...hit, path: shownPath(scope, hit.path) })) });
  } catch (err) {
    if (err instanceof HttpError) res.status(err.status).json({ error: err.message });
    else res.status(500).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
});

// PUT /api/files/write { conversation | scope: "server", path, content, baseMtimeMs }: saves over an existing text file
router.put("/write", handle((req, res) => {
  const { conversation, scope: scopeName, path, content, baseMtimeMs } = req.body ?? {};
  if (typeof content !== "string") throw new HttpError(400, "content must be a string");
  if (Buffer.byteLength(content) > MAX_TEXT) throw new HttpError(413, "File too large to save here");
  const scope = fileRoot({ conversation, scope: scopeName });
  if (!scope.writable) throw new HttpError(403, "Start the chat first: files are read-only until it has its own folder");
  const file = target(scope, String(path ?? ""));
  const stat = statSync(file);
  if (stat.isDirectory()) throw new HttpError(400, "That is a folder");
  // Someone (usually the agent) changed it since it was opened: saving would silently undo their change.
  if (typeof baseMtimeMs === "number" && Math.abs(stat.mtimeMs - baseMtimeMs) > 1) throw new HttpError(409, "The file changed on disk since you opened it");
  writeFileSync(file, content, "utf-8");
  res.json({ mtimeMs: statSync(file).mtimeMs, size: statSync(file).size });
}));

export default router;
