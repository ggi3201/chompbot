import { execFile, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { Project, ProjectGitState, RemoteRepo, RemoteRepoList } from "@chomp/shared";

const execFileAsync = promisify(execFile);

/** Projects are the git repos directly under ~/code on the host the agents run on. */
export const PROJECTS_ROOT = join(homedir(), "code");

// The info panel waits on these; a slow or locked repo must not hold it up.
const GIT_TIMEOUT_MS = 2000;

export function listProjects(root = PROJECTS_ROOT): Project[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ".git")))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findProject(path: string, root = PROJECTS_ROOT): Project | undefined {
  return listProjects(root).find((project) => project.path === path);
}

async function git(cwd: string, args: string[]): Promise<string> {
  // No optional locks: a status from the panel must not fight an agent's own git commands for the index.
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args], { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/** Branch, upstream and working-tree changes; null when the path is not a repo or git times out. */
export async function projectGitState(path: string): Promise<ProjectGitState | null> {
  const [status, shortstat] = await Promise.all([
    git(path, ["status", "--porcelain=v2", "--branch"]).catch(() => null),
    // A repo without commits has no HEAD to diff against.
    git(path, ["diff", "HEAD", "--shortstat"]).catch(() => ""),
  ]);
  return status === null ? null : parseGitState(status, shortstat);
}

function parseGitState(status: string, shortstat: string): ProjectGitState {
  const header = (key: string) => status.match(new RegExp(`^# branch\\.${key} (.+)$`, "m"))?.[1];
  const head = header("head");
  const aheadBehind = header("ab")?.match(/^\+(\d+) -(\d+)$/);
  const count = (word: string) => Number(shortstat.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  return {
    branch: head && head !== "(detached)" ? head : null,
    upstream: header("upstream") ?? null,
    ahead: Number(aheadBehind?.[1] ?? 0),
    behind: Number(aheadBehind?.[2] ?? 0),
    files: status.split("\n").filter((line) => line && !line.startsWith("#")).length,
    insertions: count("insertion"),
    deletions: count("deletion"),
  };
}

// ── GitHub repos the host can clone ──

const GH_TIMEOUT_MS = 20_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
// The list costs a few gh calls; the picker opens it often.
const REMOTE_TTL_MS = 90_000;

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const repoName = (nameWithOwner: string) => nameWithOwner.slice(nameWithOwner.indexOf("/") + 1);

let remoteCache: { at: number; repos: RemoteRepo[] } | null = null;

/** The user's own repos, their orgs' repos and the ones they collaborate on, unarchived, newest push first. */
async function fetchRemoteRepos(fresh = false): Promise<RemoteRepo[] | { unavailable: string }> {
  if (!fresh && remoteCache && Date.now() - remoteCache.at < REMOTE_TTL_MS) return remoteCache.repos;
  try {
    await gh(["auth", "status"]);
  } catch (err) {
    // Not cached: the user can install or log in to gh at any time.
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { unavailable: missing ? "The GitHub CLI (gh) is not installed on the host." : "The GitHub CLI (gh) is not logged in on the host." };
  }
  const login = (await gh(["api", "user", "--jq", ".login"])).trim();
  const orgs = (await gh(["api", "user/orgs", "--jq", ".[].login"])).split("\n").filter(Boolean);
  const owned = await Promise.all([login, ...orgs].map(async (owner) =>
    JSON.parse(await gh(["repo", "list", owner, "--limit", "1000", "--no-archived", "--json", "nameWithOwner,description,pushedAt"])) as RemoteRepo[]));
  // `repo list` only knows an owner's own repos; repos shared with the user by someone else come from this endpoint.
  const collaborating = (await gh([
    "api", "user/repos?affiliation=collaborator&per_page=100", "--paginate",
    "--jq", ".[] | select(.archived | not) | {nameWithOwner: .full_name, description, pushedAt: .pushed_at}",
  ])).split("\n").filter(Boolean).map((line) => JSON.parse(line) as RemoteRepo);
  const byName = new Map([...owned.flat(), ...collaborating].map((repo) => [repo.nameWithOwner, repo]));
  const repos = [...byName.values()]
    .map((repo) => ({ nameWithOwner: repo.nameWithOwner, description: repo.description || null, pushedAt: repo.pushedAt }))
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  remoteCache = { at: Date.now(), repos };
  return repos;
}

/** Repos the picker can offer to clone: those without a directory of their name under the root. */
export async function listRemoteRepos(root = PROJECTS_ROOT): Promise<RemoteRepoList> {
  const repos = await fetchRemoteRepos();
  if (!Array.isArray(repos)) return { repos: [], ...repos };
  return { repos: repos.filter((repo) => !existsSync(join(root, repoName(repo.nameWithOwner)))) };
}

/** A clone refused before it started; `status` is the HTTP status to answer with. */
export class CloneError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const cloning = new Set<string>();

/**
 * Clones one of the listed repos into root/<name>. It throws a CloneError before
 * `onStart` when it refuses; after that it reports git's progress lines. A clone
 * that fails or runs out of time leaves no directory behind.
 */
export async function cloneRepo(
  nameWithOwner: string,
  { root = PROJECTS_ROOT, timeoutMs = CLONE_TIMEOUT_MS, onStart, onProgress }: {
    root?: string;
    timeoutMs?: number;
    onStart?: () => void;
    onProgress?: (text: string) => void;
  } = {},
): Promise<Project> {
  // Only a repo from gh's own list, never a name the client made up; a repo made a minute ago may need a fresh list.
  const find = (repos: Awaited<ReturnType<typeof fetchRemoteRepos>>) => Array.isArray(repos) ? repos.find((r) => r.nameWithOwner === nameWithOwner) : undefined;
  const repo = find(await fetchRemoteRepos()) ?? find(await fetchRemoteRepos(true));
  if (!repo) throw new CloneError(`${nameWithOwner} is not one of the repos gh lists`, 400);
  const name = repoName(repo.nameWithOwner);
  const path = join(root, name);
  if (cloning.has(path) || existsSync(path)) throw new CloneError(`${path} already exists`, 409);

  cloning.add(path);
  try {
    onStart?.();
    mkdirSync(root, { recursive: true });
    await runClone(repo.nameWithOwner, path, timeoutMs, onProgress);
    return { name, path };
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw err;
  } finally {
    cloning.delete(path);
  }
}

function runClone(nameWithOwner: string, path: string, timeoutMs: number, onProgress?: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout stops git along with gh. --progress: git only reports to a terminal otherwise.
    const child = spawn("gh", ["repo", "clone", nameWithOwner, path, "--", "--progress"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    let lastLine = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = chunk.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) return;
      lastLine = lines[lines.length - 1];
      onProgress?.(lastLine);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error(`The clone of ${nameWithOwner} timed out after ${Math.round(timeoutMs / 1000)}s`));
      else reject(new Error(`The clone of ${nameWithOwner} failed: ${lastLine || `gh exited with ${code}`}`));
    });
  });
}
