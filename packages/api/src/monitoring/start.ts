import { syncAlertsBot } from "./alerts-bot.js";
import { notifyNewWarnings } from "./alerts.js";
import { runAllChecks, runDueChecks } from "./engine.js";
import { collectHomeAssistant } from "./homeassistant.js";
import { syncHostWarnings } from "./hosts.js";
import { settleIncidents } from "./incidents.js";
import { collectMini } from "./local-metrics.js";
import { runDiscovery } from "./run.js";
import { rollupSince } from "./store.js";

const TICK_MS = 15_000;
const ROLLUP_EVERY_MS = 5 * 60_000;
// Two hours back covers the open hour and the one before it, in case a rollup was late.
const ROLLUP_LOOKBACK_MS = 2 * 3_600_000;
const FIRST_TICK_DELAY_MS = 5_000;
const DISCOVERY_EVERY_MS = 5 * 60_000;
const FIRST_DISCOVERY_DELAY_MS = 3_000;
const HOSTS_EVERY_MS = 60_000;
const FIRST_HOSTS_DELAY_MS = 2_000;

/** Says why a source failed once per change, so an hour of outage is one line and not sixty. */
const lastProblem = new Map<string, string>();
function report(source: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (lastProblem.get(source) === message) return;
  lastProblem.set(source, message);
  console.error(`[monitoring] ${source} failed:`, message);
}

/** Calls while a run is going share it: a slow run never stacks, and Refresh waits for the one already under way. */
function single<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => (current ??= run().finally(() => { current = null; }));
}

let lastRollup = 0;

const tick = single(async () => {
  try {
    await runDueChecks();
    settleIncidents(Date.now());
    await notifyNewWarnings();
    syncAlertsBot();
    if (Date.now() - lastRollup >= ROLLUP_EVERY_MS) {
      rollupSince(Date.now() - ROLLUP_LOOKBACK_MS);
      lastRollup = Date.now();
    }
  } catch (err) {
    console.error("[monitoring] tick failed:", err instanceof Error ? err.message : err);
  }
});

const discover = single(async () => {
  try {
    await runDiscovery();
  } catch (err) {
    console.error("[monitoring] discovery failed:", err instanceof Error ? err.message : err);
  }
});

const collectHosts = single(async () => {
  try {
    // Home Assistant being down is a result, not a reason to skip the mini.
    const results = await Promise.allSettled([collectMini(), collectHomeAssistant()]);
    for (const [source, result] of [["local metrics", results[0]], ["Home Assistant", results[1]]] as const) {
      if (result.status === "rejected") report(source, result.reason);
      else lastProblem.delete(source);
    }
    syncHostWarnings();
  } catch (err) {
    report("host warnings", err);
  }
});

/** Refresh from the page: discovery and host stats first, so new and changed targets are in, then every check. */
export async function refreshNow(): Promise<{ checked: number; durationMs: number }> {
  const started = Date.now();
  await Promise.all([discover(), collectHosts()]);
  const checked = await runAllChecks();
  settleIncidents(Date.now());
  return { checked, durationMs: Date.now() - started };
}

/**
 * Runs checks and discovery in this process, as the MCP health monitor does. The nightly rollup and prune runs
 * with the other retention jobs (lib/retention.ts).
 */
export function startMonitoring(): void {
  setTimeout(collectHosts, FIRST_HOSTS_DELAY_MS).unref();
  setInterval(collectHosts, HOSTS_EVERY_MS).unref();
  setTimeout(discover, FIRST_DISCOVERY_DELAY_MS).unref();
  setInterval(discover, DISCOVERY_EVERY_MS).unref();
  setTimeout(tick, FIRST_TICK_DELAY_MS).unref();
  setInterval(tick, TICK_MS).unref();
  console.log("[monitoring] Started (tick: 15 s, hosts: 60 s, discovery: 5 min)");
}
