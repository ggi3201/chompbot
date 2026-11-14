import { agentSource, collectSnapshot, planTargets, type Found, type Snapshot } from "./discover.js";
import { agentHosts, freshReports, type HostReport } from "./hosts.js";
import { mergeDiscovery, syncWarnings, type MergeSummary } from "./merge.js";
import { syncProbeTargets } from "./probe-targets.js";
import type { Container, Listener, SourceStatus } from "./sources.js";
import { DISCOVERY_WARNING_KINDS, restartsLastHour, WARNING_SOURCES, type RestartSample } from "./warnings.js";

export interface DiscoveryRun {
  at: string;
  durationMs: number;
  sources: SourceStatus[];
  summary: MergeSummary;
  /** What the Ports view lists. */
  listeners: Listener[];
  containers: Container[];
  tailnetIps: string[];
  /** What each other host reported in its latest report, for the Ports view. */
  hosts: { host: string; address: string | null; listeners: Listener[]; containers: Container[] }[];
}

let lastRun: DiscoveryRun | null = null;
export const lastDiscovery = () => lastRun;

/** Restart counters sampled at each run, to tell how many restarts fell in the last hour. */
const restartSamples = new Map<string, RestartSample[]>();
const SAMPLE_WINDOW_MS = 2 * 3_600_000;

function noteRestarts(containers: Container[], now: number): Map<string, number> {
  for (const c of containers) {
    // A sample from the future means the clock moved back; it would only confuse the count.
    const samples = (restartSamples.get(c.name) ?? []).filter((s) => s.ts < now && now - s.ts <= SAMPLE_WINDOW_MS);
    restartSamples.set(c.name, [...samples, { ts: now, count: c.restarts }]);
  }
  return new Map(containers.map((c) => [c.name, restartsLastHour(restartSamples.get(c.name)!, now)]));
}

/** What another host's agent saw, shaped like a snapshot so the same planning reads it. */
const snapshotOfReport = (report: HostReport, mini: Snapshot): Snapshot => ({
  routes: [], tunnel: [], dns: [], homeIp: null, dockerSpace: [], localAddresses: [], statuses: [],
  tailnetIps: mini.tailnetIps, containers: report.containers, listeners: report.listeners,
});

/** Reads every source and every host's latest report, updates the targets and the warnings, and remembers what it saw. */
export async function runDiscovery(now = Date.now()): Promise<DiscoveryRun> {
  const started = Date.now();
  const snapshot = await collectSnapshot();
  const reported = freshReports(now);
  const planned = [
    planTargets(snapshot, noteRestarts(snapshot.containers, now)),
    ...reported.map(([host, report]) => planTargets(snapshotOfReport(report, snapshot), new Map(), { name: host, address: report.address ?? host })),
  ];
  const found: Found[] = planned.flatMap((p) => p.found);
  const warnings = planned.flatMap((p) => p.warnings);
  // A host that is not reporting cannot confirm anything: its targets are not missed and its warnings stay open.
  const ok = new Set<string>([...snapshot.statuses.filter((s) => s.state === "ok").map((s) => s.source), ...reported.map(([host]) => agentSource(host))]);
  const silent = agentHosts().filter((host) => !reported.some(([name]) => name === host)).map((host) => `${host}:`);
  const { summary, keyOf } = mergeDiscovery({ found, containers: snapshot.containers, tailnetIps: snapshot.tailnetIps, okSources: ok, now });
  const onTargets = warnings.map((w) => ({ ...w, targetKey: w.targetKey && (keyOf.get(w.targetKey) ?? w.targetKey) }));
  syncWarnings(
    onTargets,
    DISCOVERY_WARNING_KINDS.filter((kind) => WARNING_SOURCES[kind].every((source) => ok.has(source))),
    now,
    (w) => silent.some((prefix) => w.targetKey?.startsWith(prefix) ?? false),
  );
  const probe = await syncProbeTargets({ dns: ok.has("dns") ? snapshot.dns : null, homeIp: snapshot.homeIp });
  lastRun = {
    at: new Date(now).toISOString(),
    durationMs: Date.now() - started,
    sources: [...snapshot.statuses, probe],
    summary,
    listeners: snapshot.listeners,
    containers: snapshot.containers,
    tailnetIps: snapshot.tailnetIps,
    hosts: reported.map(([host, report]) => ({ host, address: report.address, listeners: report.listeners, containers: report.containers })),
  };
  return lastRun;
}
