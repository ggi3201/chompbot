import { describe, test, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findProject, listProjects, projectGitState } from "../../src/lib/projects.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString();

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projects-"));
  for (const name of ["zeta", "alpha"]) {
    mkdirSync(join(root, name));
    git(join(root, name), "init");
    writeFileSync(join(root, name, "a.txt"), "one\ntwo\n");
    git(join(root, name), "add", ".");
    git(join(root, name), "commit", "-m", "first");
  }
  mkdirSync(join(root, "not-a-repo"));
  writeFileSync(join(root, "file.txt"), "");
});

describe("listProjects", () => {
  test("lists the git repos directly under the root, by name, and nothing for a missing root", () => {
    expect(listProjects(root)).toEqual([
      { name: "alpha", path: join(root, "alpha") },
      { name: "zeta", path: join(root, "zeta") },
    ]);
    expect(listProjects(join(root, "missing"))).toEqual([]);
  });

  test("findProject only accepts a listed path", () => {
    expect(findProject(join(root, "alpha"), root)?.name).toBe("alpha");
    expect(findProject(join(root, "not-a-repo"), root)).toBeUndefined();
    expect(findProject(join(root, "alpha", ".."), root)).toBeUndefined();
  });
});

describe("projectGitState", () => {
  test("a clean repo without upstream", async () => {
    expect(await projectGitState(join(root, "zeta"))).toEqual({
      branch: "main", upstream: null, ahead: 0, behind: 0, files: 0, insertions: 0, deletions: 0,
    });
  });

  test("changes, untracked files and ahead/behind its upstream", async () => {
    const clone = join(root, "clone");
    git(root, "clone", join(root, "alpha"), clone);
    git(join(root, "alpha"), "commit", "--allow-empty", "-m", "upstream moved");
    git(clone, "fetch");
    git(clone, "commit", "--allow-empty", "-m", "local 1");
    git(clone, "commit", "--allow-empty", "-m", "local 2");
    writeFileSync(join(clone, "a.txt"), "one\n");
    appendFileSync(join(clone, "a.txt"), "three\nfour\n");
    writeFileSync(join(clone, "new.txt"), "x\n");

    expect(await projectGitState(clone)).toEqual({
      branch: "main", upstream: "origin/main", ahead: 2, behind: 1, files: 2, insertions: 2, deletions: 1,
    });
  });

  test("a detached HEAD has no branch", async () => {
    const repo = join(root, "zeta");
    git(repo, "checkout", "--detach");
    expect((await projectGitState(repo))?.branch).toBeNull();
    git(repo, "checkout", "main");
  });

  test("null when the directory is not a repo", async () => {
    expect(await projectGitState(join(root, "not-a-repo"))).toBeNull();
    expect(await projectGitState(join(root, "missing"))).toBeNull();
  });
});
