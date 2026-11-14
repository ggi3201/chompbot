import express from "express";
import type { AddressInfo } from "net";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { conversations } from "../../src/db/schema.js";
import filesRoutes from "../../src/routes/files.js";

// The deploy gate's container has no ripgrep; the server does.
const hasRipgrep = (() => {
  try {
    execFileSync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const CHAT = "f11e5000-5555-4555-8555-555555555555";
const NO_PROJECT = "f11e5000-6666-4666-8666-666666666666";
let root: string;
let outside: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

const get = (path: string) => fetch(`${url}/${path}`);
const write = (body: unknown) => fetch(`${url}/write`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "files-root-"));
  outside = mkdtempSync(join(tmpdir(), "files-outside-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src", "app.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, "README.md"), "# Hi\n");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(outside, join(root, "escape"));
  const now = new Date().toISOString();
  db.insert(conversations).values({ id: CHAT, projectPath: root, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
  db.insert(conversations).values({ id: NO_PROJECT, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
  const app = express();
  app.use(express.json());
  app.use("/files", filesRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/files`;
});
afterAll(() => server.close());

test("lists a folder, folders first, without .git", async () => {
  const body = await (await get(`list?conversation=${CHAT}`)).json();
  expect(body.writable).toBe(true);
  expect(body.entries.map((e: { name: string; type: string }) => `${e.type}:${e.name}`)).toEqual(["dir:escape", "dir:src", "file:logo.png", "file:README.md"]);
  expect((await (await get(`list?conversation=${CHAT}&path=src`)).json()).entries[0]).toMatchObject({ name: "app.ts", path: "src/app.ts", size: 26 });
});

test("reads text, and says what a binary file is without sending it", async () => {
  expect(await (await get(`read?conversation=${CHAT}&path=src/app.ts`)).json()).toMatchObject({ kind: "text", content: "export const answer = 42;\n" });
  expect(await (await get(`read?conversation=${CHAT}&path=logo.png`)).json()).toMatchObject({ kind: "binary", size: 8 });
  const raw = await get(`raw?conversation=${CHAT}&path=logo.png`);
  expect(raw.headers.get("content-type")).toBe("image/png");
  expect((await get(`raw?conversation=${CHAT}&path=src/app.ts`)).status).toBe(415);
});

test("never leaves the project, through .. or a symlink", async () => {
  expect((await get(`read?conversation=${CHAT}&path=../${outside.split("/").pop()}/secret.txt`)).status).toBe(403);
  expect((await get(`read?conversation=${CHAT}&path=${encodeURIComponent("/etc/passwd")}`)).status).toBe(403);
  expect((await get(`read?conversation=${CHAT}&path=escape/secret.txt`)).status).toBe(403);
  expect((await get(`list?conversation=${CHAT}&path=escape`)).status).toBe(403);
  expect((await write({ conversation: CHAT, path: "escape/secret.txt", content: "x" })).status).toBe(403);
  expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("nope");
});

test("saves, but refuses to overwrite a change made since the file was opened", async () => {
  const opened = await (await get(`read?conversation=${CHAT}&path=README.md`)).json();
  const saved = await write({ conversation: CHAT, path: "README.md", content: "# Edited\n", baseMtimeMs: opened.mtimeMs });
  expect(saved.status).toBe(200);
  expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("# Edited\n");

  utimesSync(join(root, "README.md"), new Date(), new Date(Date.now() + 60_000));
  expect((await write({ conversation: CHAT, path: "README.md", content: "# Stale\n", baseMtimeMs: (await saved.json()).mtimeMs })).status).toBe(409);
  expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("# Edited\n");
});

test("a chat without a project has no files", async () => {
  expect((await get(`list?conversation=${NO_PROJECT}`)).status).toBe(404);
});

test("the server view hides credential stores and env files under home", async () => {
  const { isSecretPath } = await import("../../src/routes/files.js");
  expect(isSecretPath("/home/u", "/home/u/.ssh/id_ed25519")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/.config/opa/token")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/chomp-prod/.env")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/code/app/.env.local")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/snap/chromium/common/browser-profiles/main/Cookies")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/.config/gh/hosts.yml")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/.agent-browser-states/x.json")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/.claude.json")).toBe(true);
  expect(isSecretPath("/home/u", "/home/u/.claude/skills/x/SKILL.md")).toBe(false);
  expect(isSecretPath("/home/u", "/home/u/code/app/src/env.ts")).toBe(false);
  expect(isSecretPath("/home/u", "/home/u/.sshconfig-notes.md")).toBe(false);
});

test("the server view lists home with absolute paths", async () => {
  const body = await (await get("list?scope=server")).json();
  expect(body.writable).toBe(true);
  expect(body.entries.every((e: { path: string }) => e.path.startsWith(body.root + "/"))).toBe(true);
  expect(body.entries.some((e: { name: string }) => e.name === ".ssh")).toBe(false);
});

test.skipIf(!hasRipgrep)("searches file contents and names with ripgrep, literally", async () => {
  writeFileSync(join(root, "src", "notes.md"), "a -v line\nanswer here\n");
  const text = await (await get(`search?conversation=${CHAT}&q=answer`)).json();
  expect(text.hits).toEqual(expect.arrayContaining([
    { path: "src/app.ts", line: 1, text: "export const answer = 42;" },
    { path: "src/notes.md", line: 2, text: "answer here" },
  ]));
  // A query that looks like an option is still just text.
  expect((await (await get(`search?conversation=${CHAT}&q=-v`)).json()).hits).toEqual([{ path: "src/notes.md", line: 1, text: "a -v line" }]);
  expect((await (await get(`search?conversation=${CHAT}&q=APP.T&mode=names`)).json()).hits).toEqual([{ path: "src/app.ts" }]);
  expect((await get(`search?conversation=${CHAT}&q=`)).status).toBe(400);
});

test.skipIf(!hasRipgrep)("search never follows a symlink out of the project", async () => {
  expect((await (await get(`search?conversation=${CHAT}&q=nope`)).json()).hits).toEqual([]);
});
