import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

const child = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("child_process", () => child);
import { db } from "../../src/db/index.js";
import { publishedSites } from "../../src/db/schema.js";

const dir = mkdtempSync(join(tmpdir(), "chomp-site-config-"));
vi.stubEnv("PREVIEW_SITES_DIR", dir);
const { execTrackSiteInGit } = await import("../../src/agents/tools/site-git.js");
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  db.delete(publishedSites).run();
  db.insert(publishedSites).values({ id: "test-site", slug: "test-site", title: "Test", htmlContent: "<h1>Test</h1>" }).run();
  mkdirSync(join(dir, "test-site"), { recursive: true });
  child.execFileSync.mockReset();
  child.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes("get-url")) return "https://github.com/test-owner/test-site.git";
    if (args.includes("rev-parse")) return "abc1234";
    return "test-owner";
  });
});

const calls = () => child.execFileSync.mock.calls.map(([command, args]) => ({ command, args: args as string[] }));
const commit = () => calls().find(({ command, args }) => command === "git" && args.includes("commit"))!;

test("new site repos are private with neutral author and no collaborator invite", async () => {
  vi.stubEnv("SITE_GIT_AUTHOR_NAME", "");
  vi.stubEnv("SITE_GIT_AUTHOR_EMAIL", "");
  expect(await execTrackSiteInGit("test-site")).toContain("No collaborator invited");
  expect(commit().args).toEqual(expect.arrayContaining(["user.name=Chomp", "user.email=chomp@example.invalid"]));
  expect(calls().find(({ args }) => args.includes("create"))?.args).toContain("--private");
  expect(calls().some(({ args }) => args.some((arg) => arg.includes("/collaborators/")))).toBe(false);
});

test("configured author and explicit invite are honored", async () => {
  vi.stubEnv("SITE_GIT_AUTHOR_NAME", "Example Author");
  vi.stubEnv("SITE_GIT_AUTHOR_EMAIL", "author@example.com");
  expect(await execTrackSiteInGit("test-site", { inviteCollaborator: "friend" })).toContain("Invited friend as admin");
  expect(commit().args).toEqual(expect.arrayContaining(["user.name=Example Author", "user.email=author@example.com"]));
  expect(calls().find(({ args }) => args.some((arg) => arg.includes("/collaborators/")))?.args)
    .toEqual(expect.arrayContaining(["repos/test-owner/test-site/collaborators/friend", "permission=admin"]));
});

test("SITE_GIT_INVITE_COLLABORATOR is the default invite, and explicit null still skips it", async () => {
  vi.stubEnv("SITE_GIT_INVITE_COLLABORATOR", "owner-login");
  expect(await execTrackSiteInGit("test-site")).toContain("Invited owner-login as admin");
  child.execFileSync.mockClear();
  expect(await execTrackSiteInGit("test-site", { inviteCollaborator: null })).toContain("No collaborator invited");
  expect(calls().some(({ args }) => args.some((arg) => arg.includes("/collaborators/")))).toBe(false);
});
