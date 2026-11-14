import express from "express";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { db } from "../../src/db/index.js";
import { incidents, monitorChecks } from "../../src/db/schema.js";
import monitoringRoutes, { monitoringPushRoutes } from "../../src/routes/monitoring.js";
import { getIncident, syncIncident } from "../../src/monitoring/incidents.js";
import { getTarget } from "../../src/monitoring/store.js";
import { addTarget, clearMonitoring, downForACycle, serve } from "./helpers.js";

const TOKEN = "test-monitoring-push-token";
let api: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/monitoring/push", monitoringPushRoutes);
  app.use("/api/monitoring", monitoringRoutes);
  api = await serve(app);
});
afterAll(() => api.close());
beforeEach(() => { clearMonitoring(); vi.clearAllMocks(); });

const job = () => addTarget({ key: "backup", title: "mini: pg dumps", kind: "push", pushToken: TOKEN, pushIntervalSec: 86_400, status: "up" });
const push = (path: string, init?: RequestInit) => fetch(`${api.url}/api/monitoring/push/${path}`, init);

test("GET push, as Kuma jobs call it, records an up push with its message and latency", async () => {
  job();
  const res = await push(`${TOKEN}?status=up&msg=17%20dumps&ping=42`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(getTarget("backup")).toMatchObject({ status: "up", lastPushOk: true, lastPushMsg: "17 dumps" });
  expect(db.select().from(monitorChecks).get()).toMatchObject({ ok: true, latencyMs: 42 });
});

test("a push without a status is up, and empty values from a URL template are ignored", async () => {
  job();
  expect((await push(`${TOKEN}`)).status).toBe(200);
  expect((await push(`${TOKEN}?status=up&msg=OK&ping=`)).status).toBe(200);
  expect(db.select().from(monitorChecks).all().map((c) => [c.ok, c.latencyMs])).toEqual([[true, null], [true, null]]);
});

test("status=down is a failed check at once, with the message as the error, and opens an incident a cycle later", async () => {
  job();
  const res = await push(`${TOKEN}?status=down&msg=model%20offline`);
  expect(await res.json()).toEqual({ ok: true });
  expect(getTarget("backup")).toMatchObject({ status: "down", lastPushOk: false, lastPushMsg: "model offline" });
  expect(db.select().from(monitorChecks).get()).toMatchObject({ ok: false, error: "model offline" });
  expect(db.select().from(incidents).all()).toHaveLength(0);
  syncIncident(getTarget("backup")!, "down", "model offline", Date.now() + 61_000);
  expect(db.select().from(incidents).get()).toMatchObject({ state: "open", causeKey: "backup" });
});

test("POST works the same, with the fields in the query or in a JSON body", async () => {
  job();
  await push(`${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "down", msg: "from body", ping: 7 }) });
  expect(getTarget("backup")).toMatchObject({ status: "down", lastPushMsg: "from body" });
  await push(`${TOKEN}?status=up&msg=back`, { method: "POST" });
  expect(getTarget("backup")).toMatchObject({ status: "up", lastPushMsg: "back" });
});

test("a long message is cut to 500 characters", async () => {
  job();
  await push(`${TOKEN}?msg=${"x".repeat(900)}`);
  expect(getTarget("backup")!.lastPushMsg).toHaveLength(500);
});

test("an unknown, malformed or non-push token gets 404 and records nothing", async () => {
  job();
  addTarget({ key: "web", pushToken: "web_0123456789abcdefghijklmnopqr" });
  for (const token of ["nope", "a".repeat(40), "web_0123456789abcdefghijklmnopqr", "x".repeat(100)]) {
    for (const method of ["GET", "POST"]) {
      const res = await push(token, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false });
    }
  }
  expect(db.select().from(monitorChecks).all()).toHaveLength(0);
});

test("a retired job no longer accepts pushes", async () => {
  addTarget({ key: "old", kind: "push", pushToken: TOKEN, retiredAt: "2026-11-01T00:00:00.000Z" });
  expect((await push(TOKEN)).status).toBe(404);
});

test("bad input gets 400 and records nothing", async () => {
  job();
  for (const query of ["status=sideways", "ping=fast", "ping=-5"]) {
    const res = await push(`${TOKEN}?${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  }
  expect(db.select().from(monitorChecks).all()).toHaveLength(0);
});

test("targets, overview and incidents describe the same state", async () => {
  job();
  await push(`${TOKEN}?status=down&msg=boom`);
  syncIncident(getTarget("backup")!, "down", "boom", Date.now() + 61_000);
  const { targets } = await (await fetch(`${api.url}/api/monitoring/targets`)).json();
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({ key: "backup", kind: "push", state: "down", message: "boom" });
  expect(targets[0]).not.toHaveProperty("pushToken");
  expect(targets[0].days).toHaveLength(30);

  const overview = await (await fetch(`${api.url}/api/monitoring/overview`)).json();
  expect(overview).toMatchObject({ counts: { total: 1, down: 1 }, openIncidents: 1, attention: [{ key: "backup", state: "down" }] });

  const { incidents: list } = await (await fetch(`${api.url}/api/monitoring/incidents`)).json();
  expect(list).toMatchObject([{ title: "mini: pg dumps is down", state: "open", msg: "boom", targets: [{ key: "backup" }] }]);
});

test("PATCH tracked: false ends the target's open incident", async () => {
  addTarget({ key: "windows-job", title: "windows: backup pull", status: "down" });
  downForACycle({ key: "windows-job" }, "no push", Date.now());
  const [open] = db.select().from(incidents).all();
  expect(open.state).toBe("open");

  const res = await fetch(`${api.url}/api/monitoring/targets/windows-job`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracked: false }),
  });
  expect(res.status).toBe(200);
  expect(getIncident(open.id)).toMatchObject({ state: "resolved" });
  expect(getIncident(open.id)?.events.at(-1)?.text).toBe("Closed: windows: backup pull is no longer tracked");
});
