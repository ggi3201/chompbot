import { randomBytes } from "crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  hostMetricRollups, hostMetrics, monitorChecks, monitorRollups, monitorTargets, monitorWarnings,
} from "../db/schema.js";
import type { CheckResult } from "./checks.js";
import { nextStatus, thresholdsFor, type Status, type Target } from "./schedule.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Raw checks are about 60,000 rows a day; only the hourly rollups outlive this window.
const RAW_CHECK_HOURS = 48;
const HOST_METRIC_DAYS = 7;
const ROLLUP_DAYS = 400;
const RESOLVED_WARNING_DAYS = 90;

export const hourStart = (ts: number) => Math.floor(ts / HOUR_MS) * HOUR_MS;
export const newPushToken = () => randomBytes(24).toString("base64url");

export type NewTarget = Pick<typeof monitorTargets.$inferInsert, "key" | "title" | "kind"> &
  Partial<typeof monitorTargets.$inferInsert>;

export function createTarget(input: NewTarget, now = Date.now()): Target {
  const stamp = new Date(now).toISOString();
  return db.insert(monitorTargets).values({ firstSeen: stamp, lastSeen: stamp, ...input }).returning().get();
}

/** Came from a Kuma monitor. */
export const isKuma = (target: Pick<Target, "sources">) => target.sources.some((source) => source.startsWith("kuma:"));

export function hostnameOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const getTarget = (key: string) => db.select().from(monitorTargets).where(eq(monitorTargets.key, key)).get();

type TargetPatch = Partial<Pick<typeof monitorTargets.$inferInsert, "tracked" | "hidden" | "title" | "project" | "notes" | "expectedStatus">>;

/** Applies a person's edit. Discovery leaves the edited fields alone from then on. */
export function patchTarget(key: string, patch: TargetPatch): Target | undefined {
  const target = getTarget(key);
  if (!target) return undefined;
  const userFields = [...new Set([...target.userFields, ...Object.keys(patch)])];
  return db.update(monitorTargets).set({ ...patch, userFields }).where(eq(monitorTargets.key, key)).returning().get();
}

export const activeTargets = () => db.select().from(monitorTargets).where(isNull(monitorTargets.retiredAt)).all();

export const findPushTarget = (token: string) =>
  db.select().from(monitorTargets).where(and(eq(monitorTargets.pushToken, token), eq(monitorTargets.kind, "push"), isNull(monitorTargets.retiredAt))).get();

/** Stores one check and moves the target's status by the down and up rules. */
export function recordResult(target: Target, result: CheckResult, now: number): { previous: Status; status: Status } {
  db.insert(monitorChecks).values({
    targetKey: target.key, ts: now, vantage: "home", ok: result.ok,
    statusCode: result.statusCode, latencyMs: result.latencyMs, error: result.error,
  }).run();
  const { down, up } = thresholdsFor(target.kind);
  const recent = db.select({ ok: monitorChecks.ok }).from(monitorChecks)
    .where(and(eq(monitorChecks.targetKey, target.key), eq(monitorChecks.vantage, "home")))
    .orderBy(desc(monitorChecks.ts), desc(monitorChecks.id))
    .limit(Math.max(down, up))
    .all().map((row) => row.ok);
  const status = nextStatus(target.status, recent, { down, up });
  db.update(monitorTargets)
    .set({ lastCheckedAt: now, status, ...(status !== target.status && { statusSince: new Date(now).toISOString() }) })
    .where(eq(monitorTargets.key, target.key))
    .run();
  return { previous: target.status, status };
}

export function recordPushArrival(key: string, push: { ok: boolean; msg: string | null }, now: number) {
  db.update(monitorTargets).set({ lastPushAt: now, lastPushOk: push.ok, lastPushMsg: push.msg }).where(eq(monitorTargets.key, key)).run();
  return getTarget(key)!;
}

/**
 * Recomputes the hourly rollups from raw checks and host metrics, for every hour from `since` on.
 * Safe to repeat while the raw checks are kept. Only hours that have raw checks are touched,
 * so imported history in older hours stays.
 */
export function rollupSince(since: number): void {
  // Inlined: a bound parameter makes SQLite divide as floating point, and the hour would not floor.
  const hour = sql.raw(String(HOUR_MS));
  db.run(sql`
    INSERT INTO monitor_rollups (target_key, vantage, hour, up, down, latency_avg, latency_max)
    SELECT target_key, vantage, (ts / ${hour}) * ${hour}, sum(ok), sum(1 - ok),
           avg(CASE WHEN ok THEN latency_ms END), max(CASE WHEN ok THEN latency_ms END)
    FROM monitor_checks WHERE ts >= ${hourStart(since)}
    GROUP BY target_key, vantage, ts / ${hour}
    ON CONFLICT (target_key, vantage, hour) DO UPDATE SET
      up = excluded.up, down = excluded.down, latency_avg = excluded.latency_avg, latency_max = excluded.latency_max`);
  // Host metrics roll up the same way. Their raw rows last 7 days, longer than the loop's lookback, so a rolled-up hour is never rewritten from partial data.
  db.run(sql`
    INSERT INTO host_metric_rollups (host, metric, hour, avg, max)
    SELECT host, metric, (ts / ${hour}) * ${hour}, avg(value), max(value)
    FROM host_metrics WHERE ts >= ${hourStart(since)}
    GROUP BY host, metric, ts / ${hour}
    ON CONFLICT (host, metric, hour) DO UPDATE SET avg = excluded.avg, max = excluded.max`);
}

/** Rolls up what the raw window still holds, then drops what is past its retention. */
export function rollupAndPrune(now = Date.now()) {
  // Start one hour short of the prune line, so an hour that is partly pruned never overwrites a full rollup.
  rollupSince(now - (RAW_CHECK_HOURS - 1) * HOUR_MS);
  const checks = db.delete(monitorChecks).where(lt(monitorChecks.ts, now - RAW_CHECK_HOURS * HOUR_MS)).run().changes;
  const rollups = db.delete(monitorRollups).where(lt(monitorRollups.hour, now - ROLLUP_DAYS * DAY_MS)).run().changes;
  const metrics = db.delete(hostMetrics).where(lt(hostMetrics.ts, now - HOST_METRIC_DAYS * DAY_MS)).run().changes;
  const metricRollups = db.delete(hostMetricRollups).where(lt(hostMetricRollups.hour, now - ROLLUP_DAYS * DAY_MS)).run().changes;
  const warnings = db.delete(monitorWarnings)
    .where(lt(monitorWarnings.resolvedAt, new Date(now - RESOLVED_WARNING_DAYS * DAY_MS).toISOString()))
    .run().changes;
  return { checks, rollups, metrics, metricRollups, warnings };
}
