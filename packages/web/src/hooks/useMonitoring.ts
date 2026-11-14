import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Range } from "../components/dashboard/ranges";
import { apiFetch } from "../lib/api";

export type TargetState = "up" | "down" | "stale" | "unknown";
/** Who can reach a service, widest first. */
export const EXPOSURE_LEVELS = ["public-direct", "public-tunnel", "lan", "tailnet", "local"] as const;
export type Exposure = (typeof EXPOSURE_LEVELS)[number];

export interface DayCount {
  day: string;
  up: number;
  down: number;
}

/** How the outside probe sees a public service. "stale" and "unknown" both show as not checked. */
export interface OutsideStatus {
  state: TargetState;
  lastCheckAt: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface MonitorWarning {
  key: string;
  kind: string;
  text: string;
}

export interface MonitorTarget {
  key: string;
  title: string;
  kind: "http" | "tcp" | "ping" | "push" | "host" | "container";
  tracked: boolean;
  project: string | null;
  url: string | null;
  host: string | null;
  port: number | null;
  exposure: Exposure | null;
  bind: string | null;
  container: string | null;
  image: string | null;
  unit: string | null;
  sources: string[];
  dependsOn: string[];
  hidden: boolean;
  retired: boolean;
  notes: string | null;
  expectedStatus: number | null;
  containerState: { state: string; health: string | null; restarts: number; oomKilled: boolean } | null;
  warnings: MonitorWarning[];
  /** Null unless the internet can reach the target. */
  outside: OutsideStatus | null;
  state: TargetState;
  statusSince: string | null;
  lastCheckAt: string | null;
  lastPushAt: string | null;
  latencyMs: number | null;
  message: string | null;
  uptime: number | null;
  days: DayCount[];
}

/** The fields a person can change on a target. */
export type TargetEdit = Partial<Pick<MonitorTarget, "tracked" | "hidden" | "title" | "project" | "notes" | "expectedStatus">>;

export type DiagnosisStatus = "none" | "running" | "done" | "failed";

export interface MonitorIncident {
  id: string;
  title: string;
  causeKey: string;
  /** What the incident blames, in words. */
  cause: string;
  state: "open" | "resolved";
  flapping: boolean;
  startedAt: string;
  endedAt: string | null;
  msg: string | null;
  targets: { key: string; title: string }[];
  diagnosis: DiagnosisStatus;
}

export interface IncidentEvent {
  id: number;
  ts: string;
  kind: string;
  text: string | null;
}

export interface IncidentDetail extends Omit<MonitorIncident, "targets"> {
  targets: { key: string; title: string; downAt: string; upAt: string | null }[];
  events: IncidentEvent[];
  /** The latest finished diagnosis, as the agent wrote it. */
  diagnosisText: string | null;
}

export interface OverviewWarning extends MonitorWarning {
  targetKey: string | null;
  firstSeen: string;
  /** Past the line where it will open an incident. */
  critical: boolean;
}

export interface MonitoringOverview {
  checkedAt: string;
  counts: { total: number; up: number; down: number; stale: number; unknown: number };
  attention: { key: string; title: string; state: TargetState; message: string | null; since: string | null }[];
  openIncidents: number;
  warnings: OverviewWarning[];
}

export interface DiscoverySource {
  source: string;
  state: "ok" | "skipped" | "error";
  message: string | null;
  count: number;
}

export interface MonitoringData {
  overview: MonitoringOverview;
  targets: MonitorTarget[];
  incidents: MonitorIncident[];
  discovery: { lastRunAt: string | null; sources: DiscoverySource[] };
}

export interface PortRow {
  host: string;
  port: number;
  bind: string;
  exposure: Exposure;
  owner: string;
  container: string | null;
  image: string | null;
  unit: string | null;
  targetKey: string | null;
  targetTitle: string | null;
}

export interface ExposureLevel {
  level: Exposure;
  label: string;
  targets: { key: string; title: string; state: TargetState; tracked: boolean; port: number | null; bind: string | null; container: string | null; outside: OutsideStatus | null }[];
  warnings: OverviewWarning[];
}

export interface HostTile {
  host: string;
  title: string;
  /** Which script sets the agent up, or null for a host that needs none. */
  agent: "linux" | "macos" | null;
  state: "up" | "down" | "unknown";
  tracked: boolean;
  lastSeen: string | null;
  uptimeSec: number | null;
  metrics: { cpu: number | null; mem: number | null; disk: number | null; temp?: number; battery?: number };
  spark: { cpu: number[]; mem: number[]; disk: number[] };
}

export interface HostTiles {
  /** Past these a value is a warning. */
  limits: { mem: number; disk: number };
  hosts: HostTile[];
}

export interface HostSeries {
  host: string;
  range: Range;
  times: string[];
  series: { cpu: number[]; mem: number[]; disk: number[]; load1: number[] };
}

/** What the token route gives, once. */
export interface HostToken {
  host: string;
  setting: string;
  token: string;
}

const POLL_MS = 30_000;
/** An open incident panel refreshes faster, so a running diagnosis shows up when it finishes. */
const INCIDENT_POLL_MS = 5_000;

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
}

/** The counts from the latest overview fetch, so the sidebar badge follows an edit on the page at once. */
let latestCounts: MonitoringOverview["counts"] | null = null;
const countListeners = new Set<() => void>();
const subscribeCounts = (listener: () => void) => {
  countListeners.add(listener);
  return () => { countListeners.delete(listener); };
};

async function loadOverview(): Promise<MonitoringOverview> {
  const overview = await getJson<MonitoringOverview>("/monitoring/overview");
  latestCounts = overview.counts;
  countListeners.forEach((listener) => listener());
  return overview;
}

async function loadAll(): Promise<MonitoringData> {
  const [overview, targets, incidents, discovery] = await Promise.all([
    loadOverview(),
    getJson<{ targets: MonitorTarget[] }>("/monitoring/targets"),
    getJson<{ incidents: MonitorIncident[] }>("/monitoring/incidents"),
    getJson<MonitoringData["discovery"]>("/monitoring/discovery"),
  ]);
  return { overview, targets: targets.targets, incidents: incidents.incidents, discovery };
}

/** Data from `load`, refreshed every 30 s while the tab is visible. `load` must not change between renders. */
function usePolled<T>(load: () => Promise<T>, intervalMs = POLL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setData(await load());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load monitoring");
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, error, setError, refresh };
}

/** One of the views that fetch their own data, such as /monitoring/ports. */
export function useMonitoringResource<T>(path: string) {
  const load = useCallback(() => getJson<T>(path), [path]);
  const { data, error } = usePolled(load);
  return { data, error };
}

/** Asks the server for a diagnosis of the incident. One that is already running is not an error. */
export async function diagnoseIncident(id: string): Promise<void> {
  const res = await apiFetch(`/monitoring/incidents/${encodeURIComponent(id)}/diagnose`, { method: "POST" });
  if (!res.ok && res.status !== 409) throw new Error((await res.json()).error);
}

/** One incident with its timeline, refreshed every few seconds while it is shown. */
export function useIncident(id: string) {
  const load = useCallback(async () => (await getJson<{ incident: IncidentDetail }>(`/monitoring/incidents/${encodeURIComponent(id)}`)).incident, [id]);
  const { data, error, refresh } = usePolled(load, INCIDENT_POLL_MS);
  const diagnose = async () => {
    await diagnoseIncident(id);
    await refresh();
  };
  return { incident: data, error, diagnose };
}

export function useMonitoring() {
  const { data, error, setError, refresh } = usePolled(loadAll);
  /** Saves an edit and reloads. Throws with the server's reason when it refuses. */
  const editTarget = async (key: string, edit: TargetEdit) => {
    const res = await apiFetch(`/monitoring/targets/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(edit) });
    if (!res.ok) throw new Error((await res.json()).error);
    await refresh();
  };

  const [refreshing, setRefreshing] = useState(false);

  /** Runs discovery and every check on the server now, then reloads. */
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch("/monitoring/refresh", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Refresh failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  return { data, error, editTarget, refreshing, refreshNow };
}

/** The tracked counts for the sidebar badge: checked once a minute, and again whenever the page reloads. */
export function useMonitoringCounts() {
  usePolled(loadOverview, 60_000);
  return useSyncExternalStore(subscribeCounts, () => latestCounts);
}

const loadHostTiles = () => getJson<HostTiles>("/monitoring/hosts");

/** The host tiles, and the one action on them: making an agent token. */
export function useHostTiles() {
  const { data, error, refresh } = usePolled(loadHostTiles);

  /** Makes a new token for the host. It is shown once; the server keeps it only encrypted. */
  const issueToken = async (host: string): Promise<HostToken> => {
    const res = await apiFetch(`/monitoring/hosts/${encodeURIComponent(host)}/token`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    return body;
  };

  return { data, error, issueToken, refresh };
}

/** A host's cpu, memory and disk for the chart. */
export const useHostSeries = (host: string, range: Range) =>
  useMonitoringResource<HostSeries>(`/monitoring/hosts/${encodeURIComponent(host)}/metrics?range=${range}`);
