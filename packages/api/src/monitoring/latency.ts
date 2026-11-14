import { db } from "../db/index.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const LATENCY_RANGES = ["24h", "7d"] as const;
export type LatencyRange = (typeof LATENCY_RANGES)[number];

// 24 h from raw checks in 15 minute buckets (96 points), 7 d from the hourly rollups (168 points).
const SHAPE = {
  "24h": { bucketMs: 15 * MINUTE_MS, count: 96 },
  "7d": { bucketMs: HOUR_MS, count: 168 },
} as const satisfies Record<LatencyRange, { bucketMs: number; count: number }>;

export interface LatencySeries {
  range: LatencyRange;
  bucketMs: number;
  /** Start of each bucket, epoch ms, oldest first. */
  ts: number[];
  /** Average latency per bucket in ms, null where no check passed. Empty when the vantage has no data in the range. */
  home: (number | null)[];
  outside: (number | null)[];
}

type Vantage = "home" | "outside";

function bucketValues(targetKey: string, vantage: Vantage, range: LatencyRange, start: number): Map<number, number> {
  const { bucketMs } = SHAPE[range];
  // The bucket size is a constant of this file, inlined so SQLite divides whole numbers.
  const query = range === "24h"
    ? db.$client.prepare(`
        SELECT (ts / ${bucketMs}) * ${bucketMs} bucket, avg(latency_ms) value FROM monitor_checks
        WHERE target_key = ? AND vantage = ? AND ok = 1 AND latency_ms IS NOT NULL AND ts >= ?
        GROUP BY bucket`)
    : db.$client.prepare(`
        SELECT hour bucket, latency_avg value FROM monitor_rollups
        WHERE target_key = ? AND vantage = ? AND latency_avg IS NOT NULL AND hour >= ?`);
  return new Map((query.all(targetKey, vantage, start) as { bucket: number; value: number }[]).map((row) => [row.bucket, Math.round(row.value)]));
}

/** Latency of one target per vantage, in fixed buckets ending with the current one, so the chart needs no gap logic of its own. */
export function buildLatency(targetKey: string, range: LatencyRange, now = Date.now()): LatencySeries {
  const { bucketMs, count } = SHAPE[range];
  const first = Math.floor(now / bucketMs) * bucketMs - (count - 1) * bucketMs;
  const ts = Array.from({ length: count }, (_, i) => first + i * bucketMs);
  const series = (vantage: Vantage) => {
    const values = bucketValues(targetKey, vantage, range, first);
    return values.size ? ts.map((t) => values.get(t) ?? null) : [];
  };
  return { range, bucketMs, ts, home: series("home"), outside: series("outside") };
}
