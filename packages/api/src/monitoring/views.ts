import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { monitorTargets, monitorWarnings } from "../db/schema.js";
import type { Exposure } from "./exposure.js";
import { openIncidentCount } from "./incidents.js";
import { outsideRow, type OutsideRow } from "./outside.js";
import { isStale, type Target } from "./schedule.js";
import { isCritical } from "./warnings.js";

export const DAYS = 30;
const DAY_MS = 86_400_000;

export interface DayCount { day: string; up: number; down: number }
export type TargetState = "up" | "down" | "stale" | "unknown";

export interface WarningRow {
  key: string;
  kind: string;
  targetKey: string | null;
  text: string;
  firstSeen: string;
  /** Past the line where phase 4 opens an incident. */
  critical: boolean;
}

/** Warnings that are open and not muted, oldest first. */
export const openWarnings = (): WarningRow[] =>
  db.select({ key: monitorWarnings.key, kind: monitorWarnings.kind, targetKey: monitorWarnings.targetKey, text: monitorWarnings.text, firstSeen: monitorWarnings.firstSeen })
    .from(monitorWarnings).where(and(isNull(monitorWarnings.resolvedAt), eq(monitorWarnings.muted, false)))
    .orderBy(monitorWarnings.firstSeen).all().map((row) => ({ ...row, critical: isCritical(row.kind) }));

export interface TargetRow {
  key: string;
  title: string;
  kind: Target["kind"];
  tracked: boolean;
  project: string | null;
  url: string | null;
  host: string | null;
  port: number | null;
  /** Who can reach it. Null for targets discovery has not placed (a job, a host that pings). */
  exposure: Exposure | null;
  bind: string | null;
  container: string | null;
  image: string | null;
  unit: string | null;
  /** Where the target came from: traefik, cloudflare, dns, docker, listener, kuma:<id>. */
  sources: string[];
  dependsOn: string[];
  hidden: boolean;
  retired: boolean;
  notes: string | null;
  expectedStatus: number | null;
  /** What Docker says about the container behind it. */
  containerState: { state: string; health: string | null; restarts: number; oomKilled: boolean } | null;
  warnings: Pick<WarningRow, "key" | "kind" | "text">[];
  /** How the outside probe sees it. Null unless the internet can reach the target. */
  outside: OutsideRow | null;
  status: Target["status"];
  /** What the page shows: `status`, except that an "up" nobody has confirmed lately is "stale". */
  state: TargetState;
  statusSince: string | null;
  lastCheckAt: string | null;
  lastPushAt: string | null;
  latencyMs: number | null;
  /** Why it is down, or what a job said on its last push. */
  message: string | null;
  /** Floored so a failed check can never round up to 100%. Null with no history. */
  uptime: number | null;
  days: DayCount[];
}

export function stateOf(target: Pick<Target, "status" | "kind" | "tracked" | "lastCheckedAt">, now: number): TargetState {
  if (target.status === "down") return "down";
  if (isStale(target, now)) return "stale";
  return target.status;
}

/** Always 30 days ending today, gaps filled, and the uptime over them. */
export function buildHistory(own: DayCount[], now: number): { days: DayCount[]; uptime: number | null } {
  const days = Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(now - (DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return own.find((d) => d.day === day) ?? { day, up: 0, down: 0 };
  });
  const up = days.reduce((sum, d) => sum + d.up, 0);
  const down = days.reduce((sum, d) => sum + d.down, 0);
  return { days, uptime: up + down ? Math.floor((up / (up + down)) * 10_000) / 100 : null };
}

function dayCountsByTarget(now: number): Map<string, DayCount[]> {
  const windowStart = Date.parse(new Date(now - (DAYS - 1) * DAY_MS).toISOString().slice(0, 10));
  const rows = db.$client.prepare(`
    SELECT target_key key, strftime('%Y-%m-%d', hour / 1000, 'unixepoch') day, sum(up) up, sum(down) down
    FROM monitor_rollups WHERE vantage = 'home' AND hour >= ? GROUP BY target_key, day`)
    .all(windowStart) as (DayCount & { key: string })[];
  const byTarget = new Map<string, DayCount[]>();
  for (const { key, ...count } of rows) byTarget.set(key, [...(byTarget.get(key) ?? []), count]);
  return byTarget;
}

function latestChecks(): Map<string, { latencyMs: number | null; error: string | null }> {
  const rows = db.$client.prepare(`
    SELECT c.target_key key, c.latency_ms latencyMs, c.error error
    FROM monitor_checks c
    JOIN (SELECT target_key, max(ts) ts FROM monitor_checks WHERE vantage = 'home' GROUP BY target_key) l
      ON l.target_key = c.target_key AND l.ts = c.ts
    WHERE c.vantage = 'home' GROUP BY c.target_key`)
    .all() as { key: string; latencyMs: number | null; error: string | null }[];
  return new Map(rows.map(({ key, ...rest }) => [key, rest]));
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** One row per target, hidden and retired ones too (the page folds them): down first, then by title. */
export function buildTargetRows(now = Date.now()): TargetRow[] {
  const targets = db.select().from(monitorTargets).all();
  const history = dayCountsByTarget(now);
  const latest = latestChecks();
  const warnings = openWarnings();
  return targets.map((t): TargetRow => {
    const check = latest.get(t.key);
    const state = stateOf(t, now);
    return {
      key: t.key,
      title: t.title,
      kind: t.kind,
      tracked: t.tracked,
      project: t.project,
      url: t.url,
      host: t.host,
      port: t.port,
      exposure: t.exposure as Exposure | null,
      bind: t.bindAddress,
      container: t.container,
      image: t.image,
      unit: t.systemdUnit,
      sources: t.sources,
      dependsOn: t.dependsOn,
      hidden: t.hidden,
      retired: t.retiredAt !== null,
      notes: t.notes,
      expectedStatus: t.expectedStatus,
      containerState: t.containerInfo && { state: t.containerInfo.state, health: t.containerInfo.health, restarts: t.containerInfo.restarts, oomKilled: t.containerInfo.oomKilled },
      warnings: warnings.filter((w) => w.targetKey === t.key).map(({ key, kind, text }) => ({ key, kind, text })),
      outside: t.exposure === "public-tunnel" || t.exposure === "public-direct" ? outsideRow(t.key, now) : null,
      status: t.status,
      state,
      statusSince: t.statusSince,
      lastCheckAt: iso(t.lastCheckedAt),
      lastPushAt: iso(t.lastPushAt),
      latencyMs: check?.latencyMs ?? null,
      message: state === "down" ? check?.error ?? null : t.kind === "push" ? t.lastPushMsg : null,
      ...buildHistory(history.get(t.key) ?? [], now),
    };
  }).sort((a, b) => Number(b.state === "down") - Number(a.state === "down") || a.title.localeCompare(b.title));
}

export function buildOverview(rows: TargetRow[], now = Date.now()) {
  const tracked = rows.filter((row) => row.tracked && !row.hidden && !row.retired);
  const count = (state: TargetState) => tracked.filter((row) => row.state === state).length;
  const lastChecked = Math.max(0, ...rows.map((row) => Date.parse(row.lastCheckAt ?? "")).filter(Number.isFinite));
  return {
    checkedAt: new Date(lastChecked || now).toISOString(),
    counts: { total: tracked.length, up: count("up"), down: count("down"), stale: count("stale"), unknown: count("unknown") },
    attention: tracked.filter((row) => row.state !== "up").map((row) => ({
      key: row.key, title: row.title, state: row.state, message: row.message, since: row.statusSince,
    })),
    openIncidents: openIncidentCount(),
    warnings: openWarnings(),
  };
}
