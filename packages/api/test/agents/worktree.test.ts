import { describe, expect, test, vi } from "vitest";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";

// Worktrees land under $HOME/chomp-work; keep them in a throwaway home.
vi.hoisted(() => {
  process.env.HOME = `/tmp/chomp-home-${process.pid}-${Date.now()}`;
});

import { db } from "../../src/db/index.js";
import { conversations } from "../../src/db/schema.js";
import { conversationCwd, ownedWorktreePaths, removeConversationWorktree } from "../../src/agents/worktree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf-8" }).trim();

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "chomp-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return repo;
}

function convo(projectPath: string | null, extra: Partial<typeof conversations.$inferInsert> = {}) {
  const id = randomUUID();
  db.insert(conversations).values({ id, projectPath, ...extra }).run();
  return id;
}

const row = (id: string) => db.select().from(conversations).where(eq(conversations.id, id)).get()!;

describe("conversation worktrees", () => {
  test("a fresh chat in a git project gets its own worktree, reused on later turns", () => {
    const repo = makeRepo();
    const a = convo(repo);
    const b = convo(repo);

    const cwdA = conversationCwd(a)!;
    const cwdB = conversationCwd(b)!;
    expect(cwdA).not.toBe(repo);
    expect(cwdA).not.toBe(cwdB);
    expect(git(cwdA, "branch", "--show-current")).toBe(`chomp/${a.slice(0, 8)}`);
    expect(row(a).worktreePath).toBe(cwdA);
    expect(conversationCwd(a)).toBe(cwdA);
    expect([...ownedWorktreePaths()]).toEqual(expect.arrayContaining([cwdA, cwdB]));
  });

  test("untracked dependencies and env files are linked into the worktree", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, ".env"), "SECRET=1");
    const cwd = conversationCwd(convo(repo))!;
    expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("SECRET=1");
    expect(existsSync(join(cwd, "node_modules"))).toBe(true);
  });

  test("a worktree removed under a chat comes back on its branch", () => {
    const repo = makeRepo();
    const a = convo(repo);
    const cwd = conversationCwd(a)!;
    writeFileSync(join(cwd, "b.txt"), "b");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "work");
    git(repo, "worktree", "remove", cwd);

    expect(conversationCwd(a)).toBe(cwd);
    expect(existsSync(join(cwd, "b.txt"))).toBe(true);
  });

  test("chats without a project, outside git, with a session already in the repo, or opted out keep the plain path", () => {
    const repo = makeRepo();
    const plain = mkdtempSync(join(tmpdir(), "chomp-plain-"));
    expect(conversationCwd(convo(null))).toBeNull();
    expect(conversationCwd(convo(plain))).toBe(plain);
    expect(conversationCwd(convo(repo, { ccSessionId: "s1" }))).toBe(repo);
    expect(conversationCwd(convo(repo, { useWorktree: false }))).toBe(repo);
  });

  test("deleting a chat removes a clean worktree and keeps a dirty one", () => {
    const repo = makeRepo();
    const cleanId = convo(repo);
    const dirtyId = convo(repo);
    const clean = conversationCwd(cleanId)!;
    const dirty = conversationCwd(dirtyId)!;
    writeFileSync(join(dirty, "wip.txt"), "unsaved");

    removeConversationWorktree(row(cleanId));
    removeConversationWorktree(row(dirtyId));
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(join(dirty, "wip.txt"))).toBe(true);
  });
});
