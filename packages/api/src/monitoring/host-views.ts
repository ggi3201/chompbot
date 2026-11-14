import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { hostMetrics, monitorTargets } from "../db/schema.js";
import { hostDef, hostKey, isFresh, KNOWN_HOSTS, type HostDef } from "./hosts.js";
import { DISK_WARN_PCT, MEMORY_WARN_PCT } from "./warnings.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

export const HOST_RANGES = ["24h", "7d", "30d"] as const;
export type HostRange = (typeof HOST_RANGES)[number];

/** How a range is drawn: the width of a point, how many there are, and where they come from. */
const RANGE_SHAPE: Record<HostRange, { bucketMs: number; count: number; from: "raw" | "rollups" }> = {
  "24h": { bucketMs: 15 * MINUTE, count: 96, from: "raw" },
  "7d": { bucketMs: HOUR, count: 168, from: "rollups" },
  "30d": { bucketMs: 4 * HOUR, count: 180, from: "rollups" },
};
/** A tile's trend: the last 24 hours in 48 points. */
const SPARK_SHAPE = { bucketMs: 30 * MINUTE, count: 48, from: "raw" } as const;

interface Shape { bucketMs: number; count: number; from: "raw" | "rollups" }
interface BucketRow { bucket: number; value: number }

/** The average of each bucket, from the bucket that ends at `now` back `count` buckets. A bucket with no readings is null. */
export function averagesByBucket(rows: BucketRow[], { bucketMs, count }: Pick<Shape, "bucketMs" | "count">, now: number): (number | null)[] {
  const first = Math.floor(now / bucketMs) * bucketMs - (count - 1) * bucketMs;
  const out: (number | null)[] = Array.from({ length: count }, () => null);
  for (const { bucket, value } of rows) {
    const index = (bucket - first) / bucketMs;
    if (Number.isInteger(index) && index >= 0 && index < count) out[index] = value;
  }
  return out;
}

/**
 * Turns series with gaps into series a chart can draw. The chart starts at the first bucket where any series has a reading
 * (the time before is not drawn), and a bucket with no reading repeats the one before. A series with no readings at all is zeros.
 */
export function fillBuckets<K extends string>(columns: Record<K, (number | null)[]>): { start: number; columns: Record<K, number[]> } {
  const all = Object.values<(number | null)[]>(columns);
  const count = all[0]?.length ?? 0;
  const found = Array.from({ length: count }, (_, i) => i).find((i) => all.some((column) => column[i] !== null));
  const start = found ?? count;
  const filled = Object.fromEntries(Object.entries<(number | null)[]>(columns).map(([key, column]) => {
    let last = column.find((v) => v !== null) ?? 0;
    return [key, column.slice(start).map((v) => (last = v ?? last))];
  }));
  return { start, columns: filled as Record<K, number[]> };
}

const round = (value: number) => Math.round(value * 10) / 10;

function bucketRows(host: string, metric: string, shape: Shape, now: number): BucketRow[] {
  const since = Math.floor(now / shape.bucketMs) * shape.bucketMs - (shape.count - 1) * shape.bucketMs;
  // The bucket width is ours, not the caller's, and is inlined: a bound parameter would make SQLite divide as floating point.
  const query = shape.from === "raw"
    ? `SELECT (ts / ${shape.bucketMs}) * ${shape.bucketMs} AS bucket, avg(value) AS value FROM host_metrics WHERE host = ? AND metric = ? AND ts >= ? GROUP BY bucket`
    : `SELECT (hour / ${shape.bucketMs}) * ${shape.bucketMs} AS bucket, avg(avg) AS value FROM host_metric_rollups WHERE host = ? AND metric = ? AND hour >= ? GROUP BY bucket`;
  return db.$client.prepare(query).all(host, metric, since) as BucketRow[];
}

const SERIES = { cpu: "cpu_pct", mem: "mem_pct", disk: "disk_pct", load1: "load1" } as const;

export interface HostSeries {
  host: string;
  range: HostRange;
  /** Start of each point, ISO. The same for every series. */
  times: string[];
  series: Record<keyof typeof SERIES, number[]>;
}

/** A host's cpu, memory, disk and load for a chart. Averages per point. */
export function buildHostSeries(host: string, range: HostRange, now = Date.now()): HostSeries {
  const shape = RANGE_SHAPE[range];
  const columns = Object.fromEntries(Object.entries(SERIES).map(([key, metric]) => [key, averagesByBucket(bucketRows(host, metric, shape, now), shape, now)])) as Record<keyof typeof SERIES, (number | null)[]>;
  const { start, columns: filled } = fillBuckets(columns);
  const first = Math.floor(now / shape.bucketMs) * shape.bucketMs - (shape.count - 1) * shape.bucketMs;
  return {
    host,
    range,
    times: Array.from({ length: shape.count - start }, (_, i) => new Date(first + (start + i) * shape.bucketMs).toISOString()),
    series: Object.fromEntries(Object.entries(filled).map(([key, values]) => [key, values.map(round)])) as HostSeries["series"],
  };
}

// ── Tiles ───────────────────────────────────────────────────────────────

export interface HostTile {
  host: string;
  title: string;
  /** Which script sets up the agent, or null for a host that needs none. */
  agent: HostDef["agent"];
  /** "up" while it reports, "down" when it went quiet, "unknown" when it never reported. */
  state: "up" | "down" | "unknown";
  tracked: boolean;
  /** ISO time of the last report, null when there never was one. */
  lastSeen: string | null;
  uptimeSec: number | null;
  /** The latest readings. `temp` and `battery` are left out where the host has none. */
  metrics: { cpu: number | null; mem: number | null; disk: number | null; temp?: number; battery?: number };
  spark: { cpu: number[]; mem: number[]; disk: number[] };
}

const latest = (host: string, metric: string): number | null =>
  db.select({ value: hostMetrics.value }).from(hostMetrics).where(and(eq(hostMetrics.host, host), eq(hostMetrics.metric, metric))).orderBy(desc(hostMetrics.ts)).limit(1).get()?.value ?? null;

const spark = (host: string, metric: string, now: number): number[] =>
  fillBuckets({ v: averagesByBucket(bucketRows(host, metric, SPARK_SHAPE, now), SPARK_SHAPE, now) }).columns.v.map(round);

function tileOf(def: HostDef, tracked: boolean, lastSeen: number | null, now: number): HostTile {
  const { host } = def;
  const [temp, battery] = [latest(host, "temp_c"), latest(host, "battery_pct")];
  const uptime = latest(host, "uptime_sec");
  return {
    host,
    title: def.title,
    agent: def.agent,
    state: lastSeen === null ? "unknown" : isFresh(lastSeen, now) ? "up" : "down",
    tracked,
    lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    uptimeSec: uptime === null ? null : Math.round(uptime),
    metrics: {
      cpu: latest(host, "cpu_pct"), mem: latest(host, "mem_pct"), disk: latest(host, "disk_pct"),
      ...(temp !== null && { temp }), ...(battery !== null && { battery }),
    },
    spark: { cpu: spark(host, "cpu_pct", now), mem: spark(host, "mem_pct", now), disk: spark(host, "disk_pct", now) },
  };
}

/** This machine, the known hosts that have reported, then any other host that has. */
export function buildHostTiles(now = Date.now()) {
  const targets = new Map(db.select().from(monitorTargets).where(eq(monitorTargets.kind, "host")).all().filter((t) => !t.retiredAt).map((t) => [t.key, t]));
  const extra = [...targets.values()].map((t) => t.host ?? t.key).filter((host) => !KNOWN_HOSTS.some((def) => def.host === host));
  return {
    /** Past these a value turns amber on the page. The warnings use the same lines. */
    limits: { mem: MEMORY_WARN_PCT, disk: DISK_WARN_PCT },
    // A known host shows only once it has reported, so a fresh install does not list machines it does not have.
    hosts: [...KNOWN_HOSTS.filter((def) => def.source === "local" || targets.has(hostKey(def.host))).map((def) => def.host), ...extra].map((host) => {
      const def = hostDef(host);
      const target = targets.get(hostKey(host));
      return tileOf(def, target?.tracked ?? def.tracked, target?.lastPushAt ?? null, now);
    }),
  };
}
