import express from "express";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { incidentEvents, incidents, incidentTargets, monitorChecks } from "../../src/db/schema.js";
import { applyPush, runDueChecks } from "../../src/monitoring/engine.js";
import { listIncidents } from "../../src/monitoring/incidents.js";
import { getTarget } from "../../src/monitoring/store.js";
import { addTarget, clearMonitoring, MINUTE, NOW, serve } from "./helpers.js";

let status = 200;
let site: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  const app = express();
  app.get("/", (_req, res) => { res.status(status).send("x"); });
  site = await serve(app);
});
afterAll(() => site.close());
beforeEach(() => { status = 200; clearMonitoring(); });

const web = (key = "web", extra = {}) => addTarget({ key, url: site.url, ...extra });
/** Runs the scheduler `minutes` after the start. */
const tick = (minutes: number) => runDueChecks(NOW + minutes * MINUTE);
const statusOf = (key = "web") => getTarget(key)!.status;

test("a new target is checked at once, and not again before its interval has passed", async () => {
  web();
  expect(await tick(0)).toBe(1);
  expect(await tick(0.5)).toBe(0);
  expect(await tick(1)).toBe(1);
  expect(db.select().from(monitorChecks).all()).toHaveLength(2);
  expect(statusOf()).toBe("up");
  expect(getTarget("web")!.lastCheckedAt).toBe(NOW + MINUTE);
});

test("untracked targets are checked every 5 minutes, and a retired one is left alone", async () => {
  web("quiet", { tracked: false });
  web("old", { retiredAt: "2026-11-01T00:00:00.000Z" });
  expect(await tick(0)).toBe(1);
  expect(await tick(4)).toBe(0);
  expect(await tick(5)).toBe(1);
  expect(getTarget("old")!.lastCheckedAt).toBeNull();
});

test("three failed checks, then one more cycle, open one incident, and two passes close it", async () => {
  web();
  await tick(0);
  status = 500;
  await tick(1);
  await tick(2);
  expect(statusOf()).toBe("up");
  expect(listIncidents()).toHaveLength(0);

  await tick(3);
  expect(statusOf()).toBe("down");
  expect(listIncidents()).toHaveLength(0); // held for a cycle, so the cause can be found

  await tick(4);
  const [incident] = listIncidents({ now: NOW + 4 * MINUTE });
  expect(incident).toMatchObject({ state: "open", title: "web is down", causeKey: "web", msg: "HTTP 500", endedAt: null });
  expect(incident!.targets).toEqual([{ key: "web", title: "web" }]);

  await tick(5); // still down: stays one incident
  expect(db.select().from(incidents).all()).toHaveLength(1);

  status = 200;
  await tick(6);
  expect(statusOf()).toBe("down");
  await tick(7);
  expect(statusOf()).toBe("up");
  const [resolved] = listIncidents({ now: NOW + 7 * MINUTE });
  expect(resolved).toMatchObject({ state: "resolved", endedAt: new Date(NOW + 7 * MINUTE).toISOString() });
  expect(db.select().from(incidentEvents).all().map((e) => e.kind)).toEqual(["opened", "recovered", "resolved"]);
  expect(db.select().from(incidentTargets).get()?.upAt).toBe(resolved!.endedAt);
});

test("an untracked target going down opens no incident", async () => {
  web("quiet", { tracked: false });
  status = 500;
  for (const minutes of [0, 5, 10]) await tick(minutes);
  expect(statusOf("quiet")).toBe("down");
  expect(listIncidents()).toHaveLength(0);
});

test("one failing target does not stop the others", async () => {
  web("good");
  addTarget({ key: "bad", url: "http://127.0.0.1:1/" });
  await tick(0);
  expect(statusOf("good")).toBe("up");
  expect(db.select().from(monitorChecks).all()).toHaveLength(2);
});

test("a push job that says down is down at once, with its message as the error", async () => {
  const job = addTarget({ key: "backup", kind: "push", pushIntervalSec: 3600, lastPushAt: NOW, lastPushOk: true, status: "up" });
  applyPush(job, { ok: false, msg: "dump failed", latencyMs: null }, NOW + MINUTE);
  expect(statusOf("backup")).toBe("down");
  expect(getTarget("backup")).toMatchObject({ lastPushOk: false, lastPushMsg: "dump failed", lastPushAt: NOW + MINUTE });
  expect(db.select().from(monitorChecks).get()).toMatchObject({ ok: false, error: "dump failed" });
  expect(listIncidents({ now: NOW + MINUTE })).toHaveLength(0);
  await tick(2); // the next scheduled check, a cycle later, opens the incident
  expect(listIncidents({ now: NOW + 2 * MINUTE })[0]).toMatchObject({ state: "open", msg: "dump failed" });
});

test("the next push that says up brings the job back and resolves the incident", async () => {
  const job = addTarget({ key: "backup", kind: "push", pushIntervalSec: 3600, status: "down" });
  applyPush(job, { ok: false, msg: "dump failed", latencyMs: null }, NOW);
  await tick(1);
  expect(listIncidents({ now: NOW + MINUTE })[0]).toMatchObject({ state: "open" });
  applyPush(getTarget("backup")!, { ok: true, msg: "done", latencyMs: 42 }, NOW + 5 * MINUTE);
  expect(statusOf("backup")).toBe("up");
  expect(getTarget("backup")!.lastPushMsg).toBe("done");
  expect(listIncidents({ now: NOW + 5 * MINUTE })[0]).toMatchObject({ state: "resolved" });
  expect(db.select().from(monitorChecks).all().at(-1)).toMatchObject({ ok: true, latencyMs: 42 });
});

test("a push job that goes quiet is down once its interval plus the grace is over", async () => {
  const job = addTarget({ key: "backup", kind: "push", pushIntervalSec: 600 });
  applyPush(job, { ok: true, msg: null, latencyMs: null }, NOW);
  await tick(10.5); // 10 min interval, 1 min grace
  expect(statusOf("backup")).toBe("up");
  await tick(11.5);
  expect(statusOf("backup")).toBe("down");
  await tick(12.5);
  expect(listIncidents({ now: NOW + 13 * MINUTE })[0]).toMatchObject({ state: "open", msg: "No push in time" });
});
