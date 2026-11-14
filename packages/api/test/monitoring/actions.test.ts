import express from "express";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({ ...(await importOriginal<object>()), execFile: child.execFile }));

import { db } from "../../src/db/index.js";
import { incidentEvents } from "../../src/db/schema.js";
import { saveSecret } from "../../src/lib/secrets.js";
import monitoringRoutes from "../../src/routes/monitoring.js";
import { NOW, addTarget, clearMonitoring, downForACycle, serve } from "./helpers.js";

type Reply = string | { stdout?: string; stderr?: string } | Error;
/** Replies by command line prefix, first match wins. A command nobody listed fails with an error. */
let replies: [string, Reply][] = [];
const calls: string[] = [];

child.execFile.mockImplementation((command: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
  const line = [command, ...args].join(" ");
  calls.push(line);
  const reply = replies.find(([prefix]) => line.startsWith(prefix))?.[1] ?? new Error(`unexpected command: ${line}`);
  if (reply instanceof Error) return callback(reply, "", String((reply as { stderr?: string }).stderr ?? reply.message));
  if (typeof reply === "string") return callback(null, reply, "");
  callback(null, reply.stdout ?? "", reply.stderr ?? "");
});

let api: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/monitoring", monitoringRoutes);
  api = await serve(app);
});
afterAll(() => api.close());
beforeEach(() => {
  clearMonitoring();
  db.delete(incidentEvents).run();
  saveSecret("MONITOR_RESTART_UNITS", "");
  replies = [];
  calls.length = 0;
});

const get = (path: string) => fetch(`${api.url}/api/monitoring${path}`);
const post = (path: string) => fetch(`${api.url}/api/monitoring${path}`, { method: "POST" });
const notFound = (command: string) => Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
const failed = (stderr: string) => Object.assign(new Error("Command failed"), { code: 1, stderr });

const container = () => addTarget({ key: "mini:8080", title: "Web", host: "mini", container: "web-1" });
const unit = (systemdUnit = "atelier-api.service") => addTarget({ key: "mini:3000", title: "atelier", host: "mini", systemdUnit });

// ── Logs ────────────────────────────────────────────────────────────────

test("logs of a container come from docker, stdout and stderr in time order, without colour codes", async () => {
  container();
  replies = [["docker logs", {
    stdout: "2026-11-08T12:00:01.000000000Z started\n2026-11-08T12:00:03.000000000Z \u001b[32mserving\u001b[0m\n",
    stderr: "2026-11-08T12:00:02.000000000Z warning: slow disk\n",
  }]];
  const res = await get("/targets/mini%3A8080/logs");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    source: "docker",
    name: "web-1",
    lines: [
      "2026-11-08T12:00:01.000000000Z started",
      "2026-11-08T12:00:02.000000000Z warning: slow disk",
      "2026-11-08T12:00:03.000000000Z serving",
    ],
  });
  expect(calls).toEqual(["docker logs --tail 100 --timestamps web-1"]);
});

test("logs of a system unit come from journalctl", async () => {
  unit();
  replies = [
    ["systemctl --user show", "not-found\n"],
    ["journalctl", "2026-11-08T12:00:00+0100 mini atelier[1]: ready\n"],
  ];
  const body = await (await get("/targets/mini%3A3000/logs")).json();
  expect(body).toEqual({ source: "journal", name: "atelier-api.service", lines: ["2026-11-08T12:00:00+0100 mini atelier[1]: ready"] });
  expect(calls).toContain("journalctl -u atelier-api.service -n 100 --no-pager -o short-iso");
});

test("logs of a user unit ask the user journal", async () => {
  unit("atelier-api");
  replies = [
    ["systemctl --user show -p LoadState --value atelier-api.service", "loaded\n"],
    ["journalctl", "line\n"],
  ];
  await get("/targets/mini%3A3000/logs");
  expect(calls).toContain("journalctl --user -u atelier-api.service -n 100 --no-pager -o short-iso");
});

test("a service on another host has no logs here, and the answer says so", async () => {
  addTarget({ key: "rpi:80", host: "rpi", container: "pihole" });
  const res = await get("/targets/rpi%3A80/logs");
  expect(res.status).toBe(422);
  expect((await res.json()).error).toMatch(/only work for services on the machine Chomp runs on/);
  expect(calls).toEqual([]);
});

test("a target without a container or unit has nothing to read", async () => {
  addTarget({ key: "mini:9999", host: "mini" });
  const res = await get("/targets/mini%3A9999/logs");
  expect(res.status).toBe(422);
  expect((await res.json()).error).toMatch(/no container or systemd unit/);
});

test("an unknown target is 404", async () => {
  expect((await get("/targets/nope/logs")).status).toBe(404);
  expect((await post("/targets/nope/restart")).status).toBe(404);
});

test("a failing command is a 502 with the first line of what it said", async () => {
  container();
  replies = [["docker logs", failed("Error response from daemon: No such container: web-1\nmore")]];
  const res = await get("/targets/mini%3A8080/logs");
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "Error response from daemon: No such container: web-1" });
});

test("a program that is not installed says so", async () => {
  container();
  replies = [["docker logs", notFound("docker")]];
  const res = await get("/targets/mini%3A8080/logs");
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("docker is not installed on this machine");
});

test("a huge log is cut to its newest lines and long lines are shortened", async () => {
  container();
  const lines = Array.from({ length: 100 }, (_, i) => `2026-11-08T12:00:00.${String(i).padStart(9, "0")}Z ${"x".repeat(1_500)}${i}`);
  replies = [["docker logs", lines.join("\n")]];
  const body = await (await get("/targets/mini%3A8080/logs")).json();
  expect(body.lines.length).toBeLessThan(100);
  expect(body.lines.at(-1)).toContain("x99");
  expect(body.lines.join("\n").length).toBeLessThanOrEqual(64 * 1024);
});

test("a container name that looks like an option is refused before any command runs", async () => {
  addTarget({ key: "mini:1", host: "mini", container: "--privileged" });
  expect((await get("/targets/mini%3A1/logs")).status).toBe(422);
  expect(calls).toEqual([]);
});

// ── Restart ─────────────────────────────────────────────────────────────

test("a container restarts with docker", async () => {
  container();
  replies = [["docker restart web-1", "web-1\n"]];
  const res = await post("/targets/mini%3A8080/restart");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, message: "Restarted container web-1" });
  expect(calls).toEqual(["docker restart web-1"]);
});

test("a restart leaves a note in the open incident of the target", async () => {
  container();
  downForACycle({ key: "mini:8080", title: "Web", tracked: true }, "connection refused", NOW);
  replies = [["docker restart", "web-1\n"]];
  await post("/targets/mini%3A8080/restart");
  const notes = db.select().from(incidentEvents).all().filter((event) => event.kind === "note");
  expect(notes).toHaveLength(1);
  expect(notes[0].text).toBe("Restarted container web-1 from the Monitoring page");
});

test("with no open incident a restart writes no note", async () => {
  container();
  replies = [["docker restart", "web-1\n"]];
  await post("/targets/mini%3A8080/restart");
  expect(db.select().from(incidentEvents).all()).toEqual([]);
});

test("a failed restart is reported and leaves no note", async () => {
  container();
  downForACycle({ key: "mini:8080", title: "Web", tracked: true }, "refused", NOW);
  replies = [["docker restart", failed("Error response from daemon: boom")]];
  const res = await post("/targets/mini%3A8080/restart");
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ ok: false, message: "Error response from daemon: boom" });
  expect(db.select().from(incidentEvents).all().filter((e) => e.kind === "note")).toEqual([]);
});

test("a listed user unit restarts with systemctl --user", async () => {
  unit("atelier-api.service");
  saveSecret("MONITOR_RESTART_UNITS", "other, atelier-api");
  replies = [["systemctl --user show", "loaded\n"], ["systemctl --user restart atelier-api.service", ""]];
  const res = await post("/targets/mini%3A3000/restart");
  expect(await res.json()).toEqual({ ok: true, message: "Restarted unit atelier-api.service" });
  expect(calls).toContain("systemctl --user restart atelier-api.service");
});

test("a listed system unit restarts through sudo -n", async () => {
  unit();
  saveSecret("MONITOR_RESTART_UNITS", "atelier-api.service");
  replies = [["systemctl --user show", "not-found\n"], ["sudo -n systemctl restart atelier-api.service", ""]];
  expect((await post("/targets/mini%3A3000/restart")).status).toBe(200);
  expect(calls).toContain("sudo -n systemctl restart atelier-api.service");
});

test("a listed system unit is refused with a clear message when sudo needs a password", async () => {
  unit();
  saveSecret("MONITOR_RESTART_UNITS", "atelier-api.service");
  replies = [["systemctl --user show", "not-found\n"], ["sudo", failed("sudo: a password is required")]];
  const res = await post("/targets/mini%3A3000/restart");
  expect(res.status).toBe(403);
  expect((await res.json()).message).toBe("atelier-api.service is a system unit and needs sudo without a password: sudo: a password is required");
});

test("a unit that is not listed is refused and nothing runs", async () => {
  unit();
  saveSecret("MONITOR_RESTART_UNITS", "something-else.service");
  const res = await post("/targets/mini%3A3000/restart");
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ ok: false, message: "atelier-api.service is not in the setting MONITOR_RESTART_UNITS. Add it there to allow a restart from here." });
  expect(calls).toEqual([]);
});

test("chomp.service is never restarted, even when it is listed", async () => {
  unit("chomp.service");
  saveSecret("MONITOR_RESTART_UNITS", "chomp.service");
  const res = await post("/targets/mini%3A3000/restart");
  expect(res.status).toBe(403);
  expect((await res.json()).message).toMatch(/does not restart itself/);
  expect(calls).toEqual([]);
});

test("a service on another host cannot be restarted from here", async () => {
  addTarget({ key: "rpi:80", host: "rpi", container: "pihole" });
  const res = await post("/targets/rpi%3A80/restart");
  expect(res.status).toBe(422);
  expect(calls).toEqual([]);
});
