import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const installPath = mkdtempSync(join(tmpdir(), "plugin-"));
mkdirSync(join(installPath, ".claude-plugin"));
writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ description: "Reviews code" }));

const cli = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", () => ({
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    cli.calls.push(args);
    const stdout = args[1] === "list" ? JSON.stringify([{ id: "code-review@official", version: "1.0.1", scope: "user", enabled: false, installPath }]) : "";
    cb(null, { stdout, stderr: "" });
  },
}));

const { default: router } = await import("../../src/routes/plugins.js");
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
beforeAll(async () => {
  server = express().use(express.json()).use("/api/plugins", router).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins`;
});
afterAll(() => server.close());
beforeEach(() => { cli.calls = []; });

test("lists what Claude Code has installed, with the manifest's description", async () => {
  expect(await (await fetch(base)).json()).toEqual([
    { id: "code-review@official", name: "code-review", marketplace: "official", version: "1.0.1", scope: "user", enabled: false, description: "Reviews code" },
  ]);
});

test("toggle and install run Claude Code's own commands", async () => {
  await fetch(`${base}/code-review@official`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "vercel@official" }) });
  expect(cli.calls.filter((c) => c[1] !== "list")).toEqual([["plugin", "enable", "code-review@official"], ["plugin", "install", "vercel@official"]]);
});

test("an id that is not name@marketplace never reaches the CLI", async () => {
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "--scope=project x" }) });
  expect(res.status).toBe(400);
  expect(cli.calls).toHaveLength(0);
});
