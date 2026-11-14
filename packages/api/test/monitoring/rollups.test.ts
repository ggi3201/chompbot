import { beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { hostMetricRollups, hostMetrics, monitorChecks, monitorRollups, monitorWarnings } from "../../src/db/schema.js";
import { getTarget, hourStart, rollupAndPrune, rollupSince } from "../../src/monitoring/store.js";
import { buildHistory, buildOverview, buildTargetRows } from "../../src/monitoring/views.js";
import { addTarget, clearMonitoring, DAY, HOUR, MINUTE, NOW } from "./helpers.js";

beforeEach(clearMonitoring);

const check = (targetKey: string, ts: number, ok: boolean, latencyMs: number | null = 10) =>
  db.insert(monitorChecks).values({ targetKey, ts, vantage: "home", ok, latencyMs }).run();
const rollups = () => db.select().from(monitorRollups).orderBy(monitorRollups.hour).all();

test("an hour rolls up to passes, failures, and the latency of the passes", () => {
  addTarget({ key: "web" });
  const hour = hourStart(NOW - 3 * HOUR);
  check("web", hour + MINUTE, true, 10);
  check("web", hour + 2 * MINUTE, true, 30);
  check("web", hour + 3 * MINUTE, false, null);
  check("web", hour + HOUR + MINUTE, true, 5);
  rollupSince(hour);
  expect(rollups()).toEqual([
    { targetKey: "web", vantage: "home", hour, up: 2, down: 1, latencyAvg: 20, latencyMax: 30 },
    { targetKey: "web", vantage: "home", hour: hour + HOUR, up: 1, down: 0, latencyAvg: 5, latencyMax: 5 },
  ]);
});

test("rolling up again, with more checks, updates the hour instead of adding a row", () => {
  addTarget({ key: "web" });
  const hour = hourStart(NOW);
  check("web", hour + MINUTE, true);
  rollupSince(hour);
  check("web", hour + 2 * MINUTE, false, null);
  rollupSince(hour);
  rollupSince(hour);
  expect(rollups()).toMatchObject([{ up: 1, down: 1 }]);
});

test("rolling up leaves older hours, such as imported history, alone", () => {
  addTarget({ key: "web" });
  db.insert(monitorRollups).values({ targetKey: "web", hour: hourStart(NOW - 10 * DAY), up: 60, down: 0 }).run();
  check("web", NOW - MINUTE, true);
  rollupSince(NOW - 2 * HOUR);
  expect(rollups().map((r) => r.up)).toEqual([60, 1]);
});

test("the nightly job keeps raw checks 48 hours and rollups 400 days, and rolls up before it prunes", () => {
  addTarget({ key: "web" });
  check("web", NOW - 47 * HOUR, true);
  check("web", NOW - 49 * HOUR, false, null);
  check("web", NOW - MINUTE, true);
  db.insert(monitorRollups).values({ targetKey: "web", hour: hourStart(NOW - 401 * DAY), up: 1, down: 0 }).run();
  db.insert(monitorRollups).values({ targetKey: "web", hour: hourStart(NOW - 399 * DAY), up: 1, down: 0 }).run();

  const pruned = rollupAndPrune(NOW);
  expect(pruned).toMatchObject({ checks: 1, rollups: 1 });
  expect(db.select().from(monitorChecks).all()).toHaveLength(2);
  expect(rollups().map((r) => r.hour)).toEqual([
    hourStart(NOW - 399 * DAY), hourStart(NOW - 47 * HOUR), hourStart(NOW - MINUTE),
  ]);
});

test("the nightly job also prunes host metrics after 7 days and resolved warnings after 90", () => {
  db.insert(hostMetrics).values([
    { host: "mini", metric: "cpu", ts: NOW - 8 * DAY, value: 1 },
    { host: "mini", metric: "cpu", ts: NOW - 6 * DAY, value: 1 },
  ]).run();
  db.insert(hostMetricRollups).values({ host: "mini", metric: "cpu", hour: hourStart(NOW - 401 * DAY), avg: 1, max: 2 }).run();
  const warning = { kind: "tls", text: "x", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" };
  db.insert(monitorWarnings).values([
    { ...warning, key: "old", resolvedAt: new Date(NOW - 91 * DAY).toISOString() },
    { ...warning, key: "recent", resolvedAt: new Date(NOW - 89 * DAY).toISOString() },
    { ...warning, key: "open" },
  ]).run();
  expect(rollupAndPrune(NOW)).toMatchObject({ metrics: 1, metricRollups: 1, warnings: 1 });
  expect(db.select().from(monitorWarnings).all().map((w) => w.key).sort()).toEqual(["open", "recent"]);
});

test("history is always 30 days ending today, with gaps filled", () => {
  const { days } = buildHistory([{ day: "2026-11-08", up: 10, down: 2 }], NOW);
  expect(days).toHaveLength(30);
  expect(days[0]).toEqual({ day: "2026-10-10", up: 0, down: 0 });
  expect(days[29]).toEqual({ day: "2026-11-08", up: 10, down: 2 });
});

test("uptime floors, so one failure in 100k checks never reads 100%", () => {
  expect(buildHistory([{ day: "2026-11-08", up: 99_999, down: 1 }], NOW).uptime).toBe(99.99);
  expect(buildHistory([{ day: "2026-11-08", up: 5, down: 0 }], NOW).uptime).toBe(100);
  expect(buildHistory([], NOW).uptime).toBeNull();
});

test("target rows read their 30 day bars and uptime from the rollups", () => {
  addTarget({ key: "web", status: "up", lastCheckedAt: NOW - MINUTE });
  const insert = (hour: number, up: number, down: number) =>
    db.insert(monitorRollups).values({ targetKey: "web", hour: hourStart(hour), up, down }).run();
  insert(NOW - 2 * HOUR, 50, 0);
  insert(NOW - HOUR, 49, 1);
  insert(NOW - 29 * DAY, 100, 0);
  insert(NOW - 31 * DAY, 100, 100); // outside the window
  const [row] = buildTargetRows(NOW);
  expect(row!.days).toHaveLength(30);
  expect(row!.days.at(-1)).toEqual({ day: "2026-11-08", up: 99, down: 1 });
  expect(row!.days[0]).toEqual({ day: "2026-10-10", up: 100, down: 0 });
  expect(row!.uptime).toBe(99.5); // 199 of 200, floored
});

test("rows say what the page needs: stale beats up, down comes first, hidden and retired are flagged", () => {
  addTarget({ key: "b-fresh", status: "up", lastCheckedAt: NOW - MINUTE });
  addTarget({ key: "a-old", status: "up", lastCheckedAt: NOW - 10 * MINUTE });
  addTarget({ key: "c-down", status: "down", lastCheckedAt: NOW - 10 * MINUTE });
  addTarget({ key: "d-new", status: "unknown" });
  addTarget({ key: "e-hidden", status: "up", hidden: true });
  addTarget({ key: "f-retired", status: "up", retiredAt: "2026-11-01T00:00:00.000Z" });
  const rows = buildTargetRows(NOW);
  expect(rows.map((r) => [r.key, r.state])).toEqual([
    ["c-down", "down"], ["a-old", "stale"], ["b-fresh", "up"], ["d-new", "stale"], ["e-hidden", "stale"], ["f-retired", "stale"],
  ]);
  expect(rows.filter((r) => r.hidden || r.retired).map((r) => [r.key, r.hidden, r.retired])).toEqual([["e-hidden", true, false], ["f-retired", false, true]]);
});

test("a down row carries the latest error, a job its last message", () => {
  addTarget({ key: "web", status: "down", lastCheckedAt: NOW });
  check("web", NOW - 2 * MINUTE, false, null);
  db.insert(monitorChecks).values({ targetKey: "web", ts: NOW, ok: false, error: "HTTP 502" }).run();
  addTarget({ key: "job", kind: "push", status: "up", lastCheckedAt: NOW, lastPushAt: NOW - HOUR, lastPushMsg: "17 dumps" });
  const rows = Object.fromEntries(buildTargetRows(NOW).map((r) => [r.key, r]));
  expect(rows.web).toMatchObject({ message: "HTTP 502" });
  expect(rows.job).toMatchObject({ message: "17 dumps", lastPushAt: new Date(NOW - HOUR).toISOString() });
});

test("the overview counts tracked targets only and lists those that need a look", () => {
  addTarget({ key: "ok", status: "up", lastCheckedAt: NOW - MINUTE });
  addTarget({ key: "bad", status: "down", lastCheckedAt: NOW - MINUTE, statusSince: "2026-11-08T11:00:00.000Z" });
  addTarget({ key: "found", status: "down", tracked: false, lastCheckedAt: NOW - MINUTE });
  addTarget({ key: "hidden", status: "down", hidden: true, lastCheckedAt: NOW - MINUTE });
  addTarget({ key: "retired", status: "down", retiredAt: "2026-11-01T00:00:00.000Z", lastCheckedAt: NOW - MINUTE });
  const overview = buildOverview(buildTargetRows(NOW), NOW);
  expect(overview.counts).toEqual({ total: 2, up: 1, down: 1, stale: 0, unknown: 0 });
  expect(overview.attention).toEqual([{ key: "bad", title: "bad", state: "down", message: null, since: "2026-11-08T11:00:00.000Z" }]);
  expect(overview.checkedAt).toBe(new Date(NOW - MINUTE).toISOString());
  expect(getTarget("ok")).toBeDefined();
});
