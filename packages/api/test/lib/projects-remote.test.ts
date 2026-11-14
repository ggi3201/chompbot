import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cloneRepo, listRemoteRepos } from "../../src/lib/projects.js";

// A stand-in for the GitHub CLI: same arguments in, canned output out.
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "auth status") [ -n "$FAKE_GH_LOGGED_OUT" ] && exit 1; exit 0 ;;
  "api user") echo me ;;
  "api user/orgs") echo acme ;;
  "api user/repos"*)
    echo '{"nameWithOwner":"friend/shared","description":"Shared with me","pushedAt":"2026-09-01T00:00:00Z"}'
    echo '{"nameWithOwner":"acme/web","description":"The site","pushedAt":"2026-10-01T00:00:00Z"}' ;;
  "repo list")
    if [ "$3" = me ]; then
      echo '[{"nameWithOwner":"me/old","description":"","pushedAt":"2026-01-01T00:00:00Z"},{"nameWithOwner":"me/cloned","description":"here already","pushedAt":"2026-05-01T00:00:00Z"}]'
    else
      echo '[{"nameWithOwner":"acme/web","description":"The site","pushedAt":"2026-10-01T00:00:00Z"},{"nameWithOwner":"acme/slow","description":null,"pushedAt":"2026-02-01T00:00:00Z"}]'
    fi ;;
  "repo clone")
    mkdir -p "$4"
    echo "Receiving objects:  50% (1/2)" >&2
    case "$3" in acme/slow) sleep 30 ;; esac
    git init -q "$4" ;;
esac
`;

let root: string;
let fakeBin: string;
const originalPath = process.env.PATH;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "projects-remote-"));
  root = join(base, "code");
  fakeBin = join(base, "bin");
  mkdirSync(join(root, "cloned"), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "gh"), FAKE_GH);
  chmodSync(join(fakeBin, "gh"), 0o755);
});

afterAll(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_GH_LOGGED_OUT;
});

// These run first: an unavailable gh is never cached, a working one is.
describe("when gh cannot list repos", () => {
  test("says gh is missing, or logged out", async () => {
    process.env.PATH = join(root, "no-bin");
    expect(await listRemoteRepos(root)).toEqual({ repos: [], unavailable: "The GitHub CLI (gh) is not installed on the host." });
    process.env.PATH = `${fakeBin}:${originalPath}`;
    process.env.FAKE_GH_LOGGED_OUT = "1";
    expect((await listRemoteRepos(root)).unavailable).toBe("The GitHub CLI (gh) is not logged in on the host.");
    delete process.env.FAKE_GH_LOGGED_OUT;
  });
});

describe("listRemoteRepos", () => {
  test("lists the user's, their orgs' and collaborator repos not under the root, newest push first", async () => {
    process.env.PATH = `${fakeBin}:${originalPath}`;
    expect(await listRemoteRepos(root)).toEqual({
      repos: [
        { nameWithOwner: "acme/web", description: "The site", pushedAt: "2026-10-01T00:00:00Z" },
        { nameWithOwner: "friend/shared", description: "Shared with me", pushedAt: "2026-09-01T00:00:00Z" },
        { nameWithOwner: "acme/slow", description: null, pushedAt: "2026-02-01T00:00:00Z" },
        { nameWithOwner: "me/old", description: null, pushedAt: "2026-01-01T00:00:00Z" },
      ],
    });
  });
});

describe("cloneRepo", () => {
  test("refuses a repo that is not in the server's list, or whose directory exists", async () => {
    await expect(cloneRepo("someone/else", { root })).rejects.toMatchObject({ status: 400 });
    await expect(cloneRepo("../../etc", { root })).rejects.toMatchObject({ status: 400 });
    // A repo in the list whose directory exists is refused too.
    mkdirSync(join(root, "old"));
    await expect(cloneRepo("me/old", { root })).rejects.toMatchObject({ status: 409 });
  });

  test("clones into root/<name>, reporting progress, and the repo leaves the list", async () => {
    const progress: string[] = [];
    let started = false;
    const project = await cloneRepo("acme/web", { root, onStart: () => { started = true; }, onProgress: (text) => progress.push(text) });
    expect(project).toEqual({ name: "web", path: join(root, "web") });
    expect(started).toBe(true);
    expect(progress).toContain("Receiving objects:  50% (1/2)");
    expect(existsSync(join(root, "web", ".git"))).toBe(true);
    expect((await listRemoteRepos(root)).repos.map((r) => r.nameWithOwner)).not.toContain("acme/web");
  });

  test("a clone that runs past its timeout is stopped and its directory removed", async () => {
    await expect(cloneRepo("acme/slow", { root, timeoutMs: 500 })).rejects.toThrow(/timed out/);
    expect(existsSync(join(root, "slow"))).toBe(false);
  });
});
