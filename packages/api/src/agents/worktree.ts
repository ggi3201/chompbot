import { execFileSync } from "child_process";
import { existsSync, readdirSync, symlinkSync } from "fs";
import { basename, join } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";
import { DEFAULT_AGENT_CWD } from "./runtime/claude.js";

export const WORKTREES_DIR = join(DEFAULT_AGENT_CWD, "worktrees");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isGitRepo(path: string): boolean {
  try {
    return git(path, "rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false;
  }
}

function hasBranch(repo: string, branch: string): boolean {
  try {
    git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A worktree holds tracked files only, so the repo's dependencies and env files are linked in
 * to let the project run there. shortcut: top-level node_modules/.env* only (pnpm per-package
 * node_modules are not linked), and an install inside the worktree writes through to the main checkout.
 */
function linkUntracked(repo: string, worktree: string) {
  for (const name of readdirSync(repo)) {
    if (!/^(node_modules|\.env.*)$/.test(name) || existsSync(join(worktree, name))) continue;
    symlinkSync(join(repo, name), join(worktree, name));
  }
}

/** Adds the conversation's worktree on branch chomp/<id8>, reusing the branch when a cleanup removed only the directory. */
function addWorktree(repo: string, conversationId: string): string {
  const id = conversationId.slice(0, 8);
  const path = join(WORKTREES_DIR, `${basename(repo)}-${id}`);
  if (existsSync(path)) return path;
  const branch = `chomp/${id}`;
  git(repo, "worktree", "prune");
  git(repo, "worktree", "add", ...(hasBranch(repo, branch) ? [path, branch] : ["-b", branch, path, "HEAD"]));
  linkUntracked(repo, path);
  return path;
}

/**
 * Where a conversation's agents run, or null for the agent's default. A chat in
 * a git project gets its own worktree on its first turn, so two chats never
 * edit the same checkout.
 */
export function conversationCwd(conversationId: string | undefined): string | null {
  if (!conversationId) return null;
  const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!row?.projectPath) return null;
  if (row.worktreePath) return addWorktree(row.projectPath, conversationId);
  // The CLIs resume a session by its directory, so a chat that already has one in the repo stays there.
  if (!row.useWorktree || row.ccSessionId || row.codexSessionId || !isGitRepo(row.projectPath)) return row.projectPath;
  const path = addWorktree(row.projectPath, conversationId);
  db.update(conversations).set({ worktreePath: path }).where(eq(conversations.id, conversationId)).run();
  return path;
}

/** Removes a deleted conversation's worktree. A dirty one stays (git refuses), and so does the branch with its commits. */
export function removeConversationWorktree(row: { projectPath: string | null; worktreePath: string | null }) {
  if (!row.projectPath || !row.worktreePath || !existsSync(row.worktreePath)) return;
  try {
    git(row.projectPath, "worktree", "remove", row.worktreePath);
  } catch (err) {
    console.warn(`[worktree] Kept ${row.worktreePath}:`, err instanceof Error ? err.message.trim() : err);
  }
}

/** Worktree paths that belong to a conversation; cleanup must leave these alone. */
export function ownedWorktreePaths(): Set<string> {
  const rows = db.select({ path: conversations.worktreePath }).from(conversations).all();
  return new Set(rows.flatMap((r) => (r.path ? [r.path] : [])));
}
