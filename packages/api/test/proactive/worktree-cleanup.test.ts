import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  ownedWorktreePaths: vi.fn(),
}));
vi.mock("child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  existsSync: mocks.existsSync,
}));
vi.mock("../../src/agents/worktree.js", () => ({
  ownedWorktreePaths: mocks.ownedWorktreePaths,
}));

import { cleanupWorktrees } from "../../src/proactive/worktree-cleanup.js";

beforeEach(() => {
  vi.stubEnv("WORKTREE_CLEANUP_REPOS", "");
  mocks.execFileSync.mockReset();
  mocks.existsSync.mockReset().mockReturnValue(true);
  mocks.ownedWorktreePaths.mockReset().mockReturnValue(new Set());
});
afterEach(() => vi.unstubAllEnvs());

test("cleanup is opt-in and runs no commands without configured repos", async () => {
  expect(await cleanupWorktrees()).toEqual({ cleaned: [], errors: [] });
  expect(mocks.execFileSync).not.toHaveBeenCalled();
});

test("invalid config fails closed before any cleanup", async () => {
  for (const value of [
    "not json",
    "{}",
    '[{"path":"relative/path"}]',
    '[{"path":"/repo","remote":"--upload-pack=evil"}]',
    '[{"path":"/valid"},{"path":"relative"}]',
  ]) {
    vi.stubEnv("WORKTREE_CLEANUP_REPOS", value);
    const result = await cleanupWorktrees();
    expect(result.cleaned, value).toEqual([]);
    expect(result.errors, value).toEqual([expect.stringContaining("Invalid WORKTREE_CLEANUP_REPOS")]);
  }
  expect(mocks.execFileSync).not.toHaveBeenCalled();
});

test("configured repo uses origin by default and passes paths without a shell", async () => {
  const repo = '/repos/project "$(unsafe)"';
  const stale = '/repos/stale "$(unsafe)"';
  vi.stubEnv("WORKTREE_CLEANUP_REPOS", JSON.stringify([{ path: repo }]));
  mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
    if (args.includes("list")) {
      return `worktree ${repo}\nbranch refs/heads/main\n\nworktree ${stale}\ndetached\n`;
    }
    return "";
  });

  const result = await cleanupWorktrees();
  expect(result.errors).toEqual([]);
  expect(result.cleaned).toHaveLength(1);
  expect(mocks.execFileSync).toHaveBeenCalledWith(
    "git", ["-C", repo, "fetch", "--prune", "--", "origin"], expect.any(Object),
  );
  expect(mocks.execFileSync).toHaveBeenCalledWith(
    "git", ["-C", repo, "worktree", "remove", "--", stale], { stdio: "ignore" },
  );
});

test("explicit remote is honored while main and agent-owned worktrees stay untouched", async () => {
  vi.stubEnv("WORKTREE_CLEANUP_REPOS", '[{"path":"/repos/project","remote":"upstream"}]');
  mocks.ownedWorktreePaths.mockReturnValue(new Set(["/repos/owned"]));
  mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
    if (args.includes("list")) {
      return "worktree /repos/project\nbranch refs/heads/main\n\nworktree /repos/owned\ndetached\n";
    }
    return "";
  });
  expect(await cleanupWorktrees()).toEqual({ cleaned: [], errors: [] });
  expect(mocks.execFileSync).toHaveBeenCalledWith(
    "git", ["-C", "/repos/project", "fetch", "--prune", "--", "upstream"], expect.any(Object),
  );
  expect(mocks.execFileSync.mock.calls.some(([, args]) => args.includes("remove"))).toBe(false);
});

test("missing repo directories are skipped", async () => {
  vi.stubEnv("WORKTREE_CLEANUP_REPOS", '[{"path":"/missing"}]');
  mocks.existsSync.mockReturnValue(false);
  expect(await cleanupWorktrees()).toEqual({ cleaned: [], errors: [] });
  expect(mocks.execFileSync).not.toHaveBeenCalled();
});

test("failed removal reports the error and leaves the branch untouched", async () => {
  vi.stubEnv("WORKTREE_CLEANUP_REPOS", '[{"path":"/repos/project"}]');
  mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
    if (args.includes("list")) {
      return "worktree /repos/project\nbranch refs/heads/main\n\nworktree /repos/dirty\nbranch refs/heads/merged\n";
    }
    if (args.includes("--merged")) return "  merged\n";
    if (args.includes("remove")) throw new Error("contains modified files");
    return "";
  });
  const result = await cleanupWorktrees();
  expect(result.cleaned).toEqual([]);
  expect(result.errors).toEqual([expect.stringContaining("contains modified files")]);
  expect(mocks.execFileSync.mock.calls.some(([, args]) => args.includes("--force"))).toBe(false);
  expect(mocks.execFileSync.mock.calls.some(([, args]) => args.includes("-d"))).toBe(false);
});
