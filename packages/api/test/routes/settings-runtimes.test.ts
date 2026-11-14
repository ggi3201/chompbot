import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// claude: installed, logged in. codex: missing.
vi.mock("node:child_process", () => ({
  execFile: (bin: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    if (bin === "codex") return cb(new Error("spawn codex ENOENT"));
    if (args[0] === "--version") return cb(null, { stdout: "2.1.322 (Claude Code)\n", stderr: "" });
    cb(null, { stdout: '{"loggedIn": true}', stderr: "" });
  },
}));

const { default: router } = await import("../../src/routes/settings.js");
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;

beforeAll(async () => {
  const app = express().use("/api/settings", router);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

test("reports each runtime as connected, not logged in or not installed", async () => {
  const runtimes = await (await fetch(`${base}/api/settings/runtimes`)).json();
  expect(runtimes).toEqual([
    { provider: "claude", installed: true, loggedIn: true, version: "2.1.322 (Claude Code)", loginCommand: "claude auth login" },
    { provider: "codex", installed: false, loggedIn: false, loginCommand: "codex login" },
  ]);
});
