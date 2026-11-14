import { haConfig } from "../location/home-assistant.js";
import { noteArrival, recordMetrics } from "./hosts.js";

const TIMEOUT_MS = 10_000;

/**
 * Home Assistant's System Monitor integration makes one sensor per reading, named after the machine
 * (`sensor.system_monitor_processor_use`). None exist on 2026-11-08, so this finds them by pattern when they appear.
 */
const SENSORS: readonly (readonly [metric: string, pattern: RegExp])[] = [
  ["cpu_pct", /^sensor\..*processor_use/],
  ["mem_pct", /^sensor\..*memory_use_percent/],
  ["disk_pct", /^sensor\..*disk_use_percent/],
];

interface HaState { entity_id: string; state: string }

/** The sensors System Monitor made, as host metrics. Where a reading has several sensors (one per disk), the shortest id is the main one. */
export function readSensors(states: HaState[]): Record<string, number> {
  const byId = [...states].sort((a, b) => a.entity_id.length - b.entity_id.length || a.entity_id.localeCompare(b.entity_id));
  return Object.fromEntries(SENSORS.flatMap(([metric, pattern]) => {
    const value = byId.filter((s) => pattern.test(s.entity_id)).map((s) => parseFloat(s.state)).find(Number.isFinite);
    return value === undefined ? [] : [[metric, value]];
  }));
}

/** Home Assistant answering is how we know it is up. Throws when it is configured but does not answer. */
export async function collectHomeAssistant(now = Date.now()): Promise<void> {
  const ha = haConfig();
  if (!ha) return;
  const res = await fetch(`${ha.url}/api/states`, { headers: { Authorization: `Bearer ${ha.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
  recordMetrics("ha", readSensors((await res.json()) as HaState[]), now);
  noteArrival("ha", now);
}
