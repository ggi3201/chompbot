import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useMonitoringResource, type MonitorTarget } from "./useMonitoring";

export type LatencyRange = "24h" | "7d";

export interface LatencySeries {
  range: LatencyRange;
  /** Start of each bucket, epoch ms. */
  ts: number[];
  /** Milliseconds per bucket, null where nothing passed. Empty when that vantage has no data. */
  home: (number | null)[];
  outside: (number | null)[];
}

export interface LogTail {
  source: "docker" | "journal";
  name: string;
  lines: string[];
}

/** Logs and restart run on the mini, where Chomp is, and need a container or a unit to act on. */
export const canActOn = (target: Pick<MonitorTarget, "host" | "container" | "unit">) =>
  target.host === "mini" && Boolean(target.container || target.unit);

const targetPath = (key: string) => `/monitoring/targets/${encodeURIComponent(key)}`;

export function useLatency(key: string, range: LatencyRange) {
  const { data, error } = useMonitoringResource<LatencySeries>(`${targetPath(key)}/latency?range=${range}`);
  // Switching range keeps the old series until the new one arrives; showing it under the new label would mislead.
  return { series: data?.range === range ? data : null, error };
}

/** The log tail of a target, loaded when it opens and again on `refresh`. */
export function useLogs(key: string) {
  const [logs, setLogs] = useState<LogTail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${targetPath(key)}/logs`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setLogs(body);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the logs");
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { logs, error, loading, refresh };
}

export interface RestartResult { ok: boolean; message: string }

export function useRestart(key: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestartResult | null>(null);

  const restart = async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`${targetPath(key)}/restart`, { method: "POST" });
      setResult(await res.json());
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not reach Chomp" });
    } finally {
      setBusy(false);
    }
  };

  return { busy, result, restart };
}
