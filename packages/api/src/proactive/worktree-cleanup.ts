/**
 * Worktree Cleanup — scans configured repos for stale git worktrees
 * whose branches have been merged or deleted, and removes them.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { z } from "zod";
import { ownedWorktreePaths } from "../agents/worktree.js";

const cleanupReposSchema = z.array(z.object({
  path: z.string().refine(isAbsolute, "must be an absolute path"),
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default("origin"),
}));

export interface CleanupResult {
  cleaned: string[];
  errors: string[];
}

interface WorktreeInfo {
  path: string;
  branch: string | null;
  isMain: boolean;
  isDead: boolean;
}

function parseWorktrees(porcelainOutput: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const blocks = porcelainOutput.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const info: WorktreeInfo = { path: "", branch: null, isMain: false, isDead: false };

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        info.path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        info.branch = line.slice("branch ".length);
      } else if (line === "detached") {
        info.isDead = true; // detached HEAD — likely stale
      }
    }

    // First worktree listed is always the main one
    if (worktrees.length === 0) {
      info.isMain = true;
    }

    if (info.path) {
      worktrees.push(info);
    }
  }

  return worktrees;
}

function branchExistsLocally(repoPath: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", `refs/heads/${branch}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isBranchMerged(repoPath: string, branch: string): boolean {
  try {
    const merged = execFileSync("git", ["-C", repoPath, "branch", "--merged", "main"], { encoding: "utf-8" });
    return merged.split("\n").some((line) => line.trim() === branch);
  } catch {
    return false;
  }
}

export async function cleanupWorktrees(): Promise<CleanupResult> {
  const cleaned: string[] = [];
  const errors: string[] = [];
  let repos: z.infer<typeof cleanupReposSchema>;
  try {
    repos = cleanupReposSchema.parse(JSON.parse(process.env.WORKTREE_CLEANUP_REPOS || "[]"));
  } catch {
    errors.push("Invalid WORKTREE_CLEANUP_REPOS: expected a JSON array of objects with an absolute path and an optional remote name.");
    return { cleaned, errors };
  }
  const owned = ownedWorktreePaths();

  for (const repo of repos) {
    if (!existsSync(join(repo.path, ".git"))) continue;

    try {
      // Prune worktrees whose directories have already been removed
      execFileSync("git", ["-C", repo.path, "worktree", "prune"], { stdio: "ignore" });

      // Fetch latest remote state so merged-branch detection is current
      execFileSync("git", ["-C", repo.path, "fetch", "--prune", "--", repo.remote], {
        stdio: "ignore",
        timeout: 15_000,
      });

      const output = execFileSync("git", ["-C", repo.path, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
      const worktrees = parseWorktrees(output);

      for (const wt of worktrees) {
        if (wt.isMain || owned.has(wt.path)) continue;

        const branchName = wt.branch?.replace("refs/heads/", "");

        // Case 1: branch no longer exists locally (already cleaned up) — remove worktree
        // Case 2: branch is merged into main — remove worktree and local branch
        const localExists = branchName ? branchExistsLocally(repo.path, branchName) : false;
        const merged = branchName ? isBranchMerged(repo.path, branchName) : false;

        const shouldRemove = !localExists || merged || wt.isDead;

        if (!shouldRemove) continue;

        try {
          // No --force: git refuses a worktree with uncommitted edits, which may be a running agent's work.
          execFileSync("git", ["-C", repo.path, "worktree", "remove", "--", wt.path], { stdio: "ignore" });
          // Delete the local branch if it still exists and is merged
          if (branchName && localExists && merged) {
            execFileSync("git", ["-C", repo.path, "branch", "-d", "--", branchName], { stdio: "ignore" });
          }
          const repoName = repo.path.split("/").pop();
          const reason = wt.isDead ? "detached" : merged ? "merged" : "branch deleted";
          cleaned.push(`${repoName}: ${branchName ?? wt.path} (${reason})`);
        } catch (err) {
          errors.push(`Failed to remove ${wt.path}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      errors.push(`Error processing ${repo.path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { cleaned, errors };
}
