import { createHmac, timingSafeEqual } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { monitorChecks, settings } from "../db/schema.js";
import { syncWarnings } from "./merge.js";
import { onOutsideStatusChange } from "./outside-hook.js";
import { nextStatus, type Status, type Target } from "./schedule.js";
import { getTarget } from "./store.js";

// The outside probe is a Cloudflare Worker. packages/outside-probe/CONTRACT.md defines the report this module receives.

/** A report is rejected when its timestamp is further than this from our clock. */
export const REPLAY_WINDOW_SEC = 300;
/** The Worker stamps a report with the start of its run, which is seconds before it arrives. */
const REPORT_SKEW_MS = 10 * 60_000;
/** Checks that decide the outside status. Replayed oldest first, which keeps the down and up rules honest across a slide. */
const STATUS_WINDOW = 30;
/** The probe runs every minute. Without a report for this long, an outside "up" or "down" is no longer a fact. */
export const OUTSIDE_STALE_MS = 15 * 60_000;

export const PORT_WARNING_KIND = "port-open-internet";
const PORTS_SETTING = "monitor:outside-ports";

// ── Signature ───────────────────────────────────────────────────────────

const signatureOf = (secret: string, timestamp: string, body: Buffer) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;

export type SignatureVerdict = "ok" | "missing" | "stale" | "mismatch";

/** Checks `X-Chomp-Signature` over `<timestamp>.<raw body>`, and that the timestamp (unix seconds) is inside the replay window. */
export function verifySignature(
  input: { secret: string; timestamp: string | undefined; signature: string | undefined; body: Buffer },
  now: number,
): SignatureVerdict {
  const { secret, timestamp, signature, body } = input;
  if (!timestamp || !signature) return "missing";
  const expected = Buffer.from(signatureOf(secret, timestamp, body));
  const given = Buffer.from(signature);
  // timingSafeEqual throws on different lengths.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "mismatch";
  const seconds = Number(timestamp);
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - seconds) > REPLAY_WINDOW_SEC) return "stale";
  return "ok";
}

// ── Report ──────────────────────────────────────────────────────────────

const reportSchema = z.object({
  ts: z.number().int().positive(),
  vantage: z.literal("outside"),
  results: z.array(z.object({
    key: z.string().min(1).max(300),
    ok: z.boolean(),
    statusCode: z.number().int().nullable().optional(),
    latencyMs: z.number().int().min(0).nullable().optional(),
    error: z.string().nullable().optional(),
  })).max(1000),
  ports: z.array(z.object({ port: z.number().int().min(1).max(65535), open: z.boolean() })).max(100).optional(),
});
export type OutsideReport = z.infer<typeof reportSchema>;

/** Parses the raw body. Returns the reason on failure, for the 400 answer. */
export function parseReport(body: Buffer, now: number): { report: OutsideReport } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return { error: "Body is not JSON" };
  }
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ") };
  if (Math.abs(parsed.data.ts - now) > REPORT_SKEW_MS) return { error: "ts is not close to the time now" };
  return { report: parsed.data };
}

// ── Status, derived from the outside checks ─────────────────────────────

const OUTSIDE = (key: string) => and(eq(monitorChecks.targetKey, key), eq(monitorChecks.vantage, "outside"));

const recentOutside = (key: string) =>
  db.select().from(monitorChecks).where(OUTSIDE(key)).orderBy(desc(monitorChecks.ts), desc(monitorChecks.id)).limit(STATUS_WINDOW).all();

/** Replays checks (newest first) through the down and up rules, from a target with no verdict. */
export function replayStatus(newestFirst: readonly { ok: boolean }[]): Status {
  const seen: boolean[] = [];
  let status: Status = "unknown";
  for (const { ok } of [...newestFirst].reverse()) {
    seen.unshift(ok);
    status = nextStatus(status, seen);
  }
  return status;
}

export type OutsideState = "up" | "down" | "stale" | "unknown";
export interface OutsideRow {
  state: OutsideState;
  lastCheckAt: string | null;
  latencyMs: number | null;
  /** Why the last check failed, or the newest failure while the target is down. */
  error: string | null;
}

/** What the page shows for a public target: the outside status, unless the probe has gone quiet. */
export function outsideRow(key: string, now: number): OutsideRow {
  const checks = recentOutside(key);
  const latest = checks[0];
  if (!latest) return { state: "unknown", lastCheckAt: null, latencyMs: null, error: null };
  const status = replayStatus(checks);
  const state: OutsideState = now - latest.ts > OUTSIDE_STALE_MS ? "stale" : status;
  return {
    state,
    lastCheckAt: new Date(latest.ts).toISOString(),
    latencyMs: latest.latencyMs,
    error: latest.error ?? (status === "down" ? checks.find((c) => c.error)?.error ?? null : null),
  };
}

// ── Ingest ──────────────────────────────────────────────────────────────

export interface IngestSummary { stored: number; duplicate: number; unknownKeys: number; changes: number }

/**
 * Stores a verified report: one `monitor_checks` row per result, with the report's own time.
 * A URL missing from the report is not down, it was not checked this run.
 * A result that is already stored (same target, same time) is skipped, so a repeated report adds nothing.
 */
export function ingestReport(report: OutsideReport, now: number): IngestSummary {
  const summary: IngestSummary = { stored: 0, duplicate: 0, unknownKeys: 0, changes: 0 };
  const changes: { target: Target; status: Status; error: string | null }[] = [];

  db.transaction(() => {
    for (const result of report.results) {
      const target = getTarget(result.key);
      if (!target || target.retiredAt) {
        summary.unknownKeys++;
        continue;
      }
      if (db.select({ id: monitorChecks.id }).from(monitorChecks).where(and(OUTSIDE(target.key), eq(monitorChecks.ts, report.ts))).get()) {
        summary.duplicate++;
        continue;
      }
      const before = replayStatus(recentOutside(target.key));
      db.insert(monitorChecks).values({
        targetKey: target.key, ts: report.ts, vantage: "outside", ok: result.ok,
        statusCode: result.statusCode ?? null, latencyMs: result.latencyMs ?? null, error: result.error?.slice(0, 500) ?? null,
      }).run();
      summary.stored++;
      const after = replayStatus(recentOutside(target.key));
      if (after !== before) changes.push({ target, status: after, error: result.ok ? null : result.error ?? null });
    }
    if (report.ports) recordPorts(report.ports, report.ts, now);
  });

  for (const { target, status, error } of changes) {
    summary.changes++;
    // The report is stored. A hook that fails must not turn it into a failed report: the Worker would count it toward its dead-Chomp alarm.
    try {
      onOutsideStatusChange(target, status, error, now);
    } catch (err) {
      console.error(`[monitoring] outside status hook failed for ${target.key}:`, err instanceof Error ? err.message : err);
    }
  }
  return summary;
}

// ── Ports ───────────────────────────────────────────────────────────────

export interface OutsidePorts { ts: number; ports: { port: number; open: boolean }[] }

export function lastOutsidePorts(): OutsidePorts | null {
  const row = db.select().from(settings).where(eq(settings.key, PORTS_SETTING)).get();
  return row ? (JSON.parse(row.value) as OutsidePorts) : null;
}

/** Keeps the latest port results, and opens a warning for each port that answers from the internet and resolves it when it closes. */
function recordPorts(ports: OutsidePorts["ports"], ts: number, now: number): void {
  const previous = lastOutsidePorts();
  // An older report that arrives late must not undo a newer answer.
  if (previous && previous.ts > ts) return;
  const value = JSON.stringify({ ts, ports } satisfies OutsidePorts);
  db.insert(settings).values({ key: PORTS_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  const findings = ports.filter((p) => p.open).sort((a, b) => a.port - b.port).map(({ port }) => ({
    key: `${PORT_WARNING_KIND}:${port}`,
    kind: PORT_WARNING_KIND,
    targetKey: null,
    text: `Port ${port} of the home IP answers from the internet. The router forwards it.`,
  }));
  syncWarnings(findings, [PORT_WARNING_KIND], now);
}
