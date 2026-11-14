import { createHash, timingSafeEqual } from "crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { hostMetrics, monitorTargets } from "../db/schema.js";
import { getSecret, saveSecret } from "../lib/secrets.js";
import { isLoopback } from "./exposure.js";
import { syncWarnings } from "./merge.js";
import { HOST_FRESH_MS } from "./schedule.js";
import { dedupeListeners, listenerFromReport, parseDockerPs, type Container, type DockerPsRow, type Listener } from "./sources.js";
import { openHostIncident, resolveHostIncident } from "./incidents.js";
import { createTarget, getTarget, newPushToken } from "./store.js";
import { evaluateHostWarnings, HOST_WARNING_KINDS, type HostReading } from "./warnings.js";

/** Host keys are lowercase words, since they go into URLs and setting names. */
export const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export type HostSource = "local" | "agent" | "ha";
export interface HostDef {
  host: string;
  title: string;
  source: HostSource;
  /** Which script installs on it. Null for hosts that need no agent. */
  agent: "linux" | "macos" | null;
  /** A sleeping laptop is not an outage, so the MacBook does not alert. */
  tracked: boolean;
}

/** The home lab. Tiles for these show even before they send anything. */
export const KNOWN_HOSTS: readonly HostDef[] = [
  { host: "mini", title: "mini", source: "local", agent: null, tracked: true },
  { host: "rpi", title: "rpi", source: "agent", agent: "linux", tracked: true },
  { host: "ha", title: "home assistant", source: "ha", agent: null, tracked: true },
  { host: "macbook", title: "macbook", source: "agent", agent: "macos", tracked: false },
];

/** Any other host name that reports is a Linux box with an agent. */
export const hostDef = (host: string): HostDef =>
  KNOWN_HOSTS.find((def) => def.host === host) ?? { host, title: host, source: "agent", agent: "linux", tracked: true };

export const hostKey = (host: string) => `host:${host}`;

export const isFresh = (lastSeen: number | null, now: number) => lastSeen !== null && now - lastSeen <= HOST_FRESH_MS;

// ── Tokens ──────────────────────────────────────────────────────────────

export const tokenSetting = (host: string) => `MONITOR_HOST_TOKEN_${host.toUpperCase().replace(/-/g, "_")}`;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Compares digests, so the time taken does not depend on how much of the token was right or how long it is. */
export function hostTokenMatches(host: string, presented: string): boolean {
  const expected = getSecret(tokenSetting(host));
  return expected !== null && timingSafeEqual(digest(expected), digest(presented));
}

/** Makes a new token for the host, replacing any old one. The caller shows it once: it is only stored encrypted. */
export function issueHostToken(host: string): string {
  const token = newPushToken();
  saveSecret(tokenSetting(host), token);
  return token;
}

// ── Reports ─────────────────────────────────────────────────────────────

export interface HostReport {
  at: number;
  /** Where the report came from, when that is an address the mini can use. */
  address: string | null;
  listeners: Listener[];
  containers: Container[];
}

/** The latest report of each host. Discovery and the container check read it; a restart empties it, and the next report refills it. */
const reports = new Map<string, HostReport>();

export const latestReport = (host: string) => reports.get(host);
export const hostAddress = (host: string) => reports.get(host)?.address ?? null;

/** Reports that are still fresh: the hosts discovery can speak for. */
export const freshReports = (now: number) => [...reports].filter(([, report]) => isFresh(report.at, now));

/** Agents reach Chomp over the tailnet, so the sender's address is how the mini reaches that host. A proxy in front would hide it, which shows as loopback. */
export function senderAddress(remoteAddress: string | undefined): string | null {
  const address = remoteAddress?.replace(/^::ffff:/, "");
  return address && !isLoopback(address) ? address : null;
}

export interface ReportInput {
  metrics: Record<string, number | undefined>;
  listeners: { bind: string; port: number; process?: string }[];
  containers: DockerPsRow[];
}

/** Stores a host's metrics, marks it seen, and keeps its listeners and containers for the next discovery run. */
export function acceptReport(host: string, input: ReportInput, address: string | null, now: number): void {
  recordMetrics(host, input.metrics, now);
  noteArrival(host, now);
  const containers = parseDockerPs(input.containers);
  reports.set(host, { at: now, address, listeners: dedupeListeners(input.listeners.map(listenerFromReport)), containers });
}

export function recordMetrics(host: string, values: Record<string, number | undefined>, now: number): void {
  const rows = Object.entries(values).flatMap(([metric, value]) => (value === undefined ? [] : [{ host, metric, ts: now, value }]));
  if (rows.length) db.insert(hostMetrics).values(rows).onConflictDoNothing().run();
}

/** Something arrived from the host. The first arrival makes its target. A host that never arrived has none, so it never raises an alarm. */
export function noteArrival(host: string, now: number): void {
  const key = hostKey(host);
  if (!getTarget(key)) {
    const def = hostDef(host);
    createTarget({
      key, title: def.title, kind: "host", host, project: "Infra", sources: [def.source], tracked: def.tracked, lastPushAt: now, lastPushOk: true,
    }, now);
    return;
  }
  db.update(monitorTargets).set({ lastPushAt: now, lastPushOk: true }).where(eq(monitorTargets.key, key)).run();
}

const hostTargets = () => db.select().from(monitorTargets).where(eq(monitorTargets.kind, "host")).all().filter((t) => !t.retiredAt);

/** Hosts with an agent that have reported at least once. */
export const agentHosts = () => hostTargets().filter((t) => t.sources.includes("agent")).map((t) => t.host ?? t.key);

/** Hosts that have reported before and are quiet now. Their warnings stay open: silence says nothing about whether the problem is over. */
export const silentHosts = (now: number) => hostTargets().filter((t) => !isFresh(t.lastPushAt, now)).map((t) => t.host ?? t.key);

// ── Host warnings ───────────────────────────────────────────────────────

const MEMORY_LOOKBACK_MS = 15 * 60_000;

function readingOf(host: string, title: string, now: number): HostReading {
  const latestDisk = db.select({ value: hostMetrics.value }).from(hostMetrics)
    .where(and(eq(hostMetrics.host, host), eq(hostMetrics.metric, "disk_pct"))).orderBy(desc(hostMetrics.ts)).limit(1).get();
  const memory = db.select({ ts: hostMetrics.ts, value: hostMetrics.value }).from(hostMetrics)
    .where(and(eq(hostMetrics.host, host), eq(hostMetrics.metric, "mem_pct"), gte(hostMetrics.ts, now - MEMORY_LOOKBACK_MS)))
    .orderBy(hostMetrics.ts).all();
  return { host, title, diskPct: latestDisk?.value ?? null, memory };
}

/** Disk and memory warnings for the hosts that are reporting now. */
export function syncHostWarnings(now = Date.now()): void {
  const readings = hostTargets().filter((t) => isFresh(t.lastPushAt, now)).map((t) => readingOf(t.host ?? t.key, t.title, now));
  const silent = new Set(silentHosts(now).map(hostKey));
  const warnings = evaluateHostWarnings(readings, now);
  syncWarnings(warnings, HOST_WARNING_KINDS, now, (w) => w.targetKey !== null && silent.has(w.targetKey));
  // A silent host has no reading, so its incidents stay as they are until it reports again.
  for (const { host } of readings) {
    for (const kind of ["disk", "memory"] as const) {
      const critical = warnings.find((w) => w.kind === `host-${kind}-critical` && w.targetKey === hostKey(host));
      if (critical) openHostIncident(host, kind, critical.text, now);
      else resolveHostIncident(host, kind, now);
    }
  }
}
