import express from "express";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { monitorChecks, monitorRollups } from "../../src/db/schema.js";
import { buildLatency } from "../../src/monitoring/latency.js";
import monitoringRoutes from "../../src/routes/monitoring.js";
import { addTarget, clearMonitoring, DAY, HOUR, MINUTE, NOW, serve } from "./helpers.js";

let api: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  const app = express();
  app.use("/api/monitoring", monitoringRoutes);
  api = await serve(app);
});
afterAll(() => api.close());
beforeEach(() => { clearMonitoring(); addTarget({ key: "web" }); });

const check = (ts: number, latencyMs: number | null, extra: Partial<typeof monitorChecks.$inferInsert> = {}) =>
  db.insert(monitorChecks).values({ targetKey: "web", ts, ok: true, latencyMs, ...extra }).run();

test("24 h is 96 quarter-hour buckets ending with the current one", () => {
  const series = buildLatency("web", "24h", NOW + 5 * MINUTE);
  expect(series.ts).toHaveLength(96);
  expect(series.bucketMs).toBe(15 * MINUTE);
  expect(series.ts.at(-1)).toBe(NOW);
  expect(series.ts[0]).toBe(NOW - 95 * 15 * MINUTE);
});

test("a bucket is the rounded average of its passing checks, and a gap is null", () => {
  check(NOW + MINUTE, 100);
  check(NOW + 2 * MINUTE, 151);
  check(NOW + 3 * MINUTE, null, { ok: false, error: "timeout" });
  check(NOW + 4 * MINUTE, 9_000, { ok: false, error: "500" });
  check(NOW - 15 * MINUTE, 40);
  const { home } = buildLatency("web", "24h", NOW + 5 * MINUTE);
  expect(home).toHaveLength(96);
  expect(home.at(-1)).toBe(126);
  expect(home.at(-2)).toBe(40);
  expect(home.at(-3)).toBeNull();
});

test("a vantage without data is an empty series, and checks older than the window are ignored", () => {
  check(NOW - 25 * HOUR, 70);
  expect(buildLatency("web", "24h", NOW).home).toEqual([]);
  check(NOW, 30);
  const series = buildLatency("web", "24h", NOW);
  expect(series.outside).toEqual([]);
  expect(series.home.filter((v) => v !== null)).toEqual([30]);
  expect(buildLatency("web", "24h", NOW + 2 * DAY).home).toEqual([]);
});

test("outside checks fill their own series", () => {
  check(NOW, 30);
  check(NOW, 80, { vantage: "outside" });
  const series = buildLatency("web", "24h", NOW);
  expect(series.home.at(-1)).toBe(30);
  expect(series.outside.at(-1)).toBe(80);
});

test("other targets do not leak in", () => {
  db.insert(monitorChecks).values({ targetKey: "other", ts: NOW, ok: true, latencyMs: 5 }).run();
  expect(buildLatency("web", "24h", NOW).home).toEqual([]);
});

test("7 d is 168 hourly buckets read from the rollups", () => {
  db.insert(monitorRollups).values([
    { targetKey: "web", vantage: "home", hour: NOW, up: 60, down: 0, latencyAvg: 42.4, latencyMax: 90 },
    { targetKey: "web", vantage: "home", hour: NOW - 3 * HOUR, up: 0, down: 60, latencyAvg: null, latencyMax: null },
    { targetKey: "web", vantage: "home", hour: NOW - 8 * DAY, up: 60, down: 0, latencyAvg: 10, latencyMax: 10 },
    { targetKey: "web", vantage: "outside", hour: NOW - HOUR, up: 4, down: 0, latencyAvg: 120, latencyMax: 150 },
  ]).run();
  const series = buildLatency("web", "7d", NOW + 10 * MINUTE);
  expect(series.ts).toHaveLength(168);
  expect(series.bucketMs).toBe(HOUR);
  expect(series.ts.at(-1)).toBe(NOW);
  expect(series.home.at(-1)).toBe(42);
  expect(series.home.at(-4)).toBeNull();
  expect(series.home.filter((v) => v !== null)).toEqual([42]);
  expect(series.outside.at(-2)).toBe(120);
});

test("the route defaults to 24 h, takes 7d, and refuses other ranges and unknown targets", async () => {
  expect((await (await fetch(`${api.url}/api/monitoring/targets/web/latency`)).json()).range).toBe("24h");
  expect((await (await fetch(`${api.url}/api/monitoring/targets/web/latency?range=7d`)).json()).ts).toHaveLength(168);
  expect((await fetch(`${api.url}/api/monitoring/targets/web/latency?range=30d`)).status).toBe(400);
  expect((await fetch(`${api.url}/api/monitoring/targets/missing/latency`)).status).toBe(404);
});
