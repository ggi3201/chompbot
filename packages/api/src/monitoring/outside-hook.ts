import { applyStatusChange } from "./incidents.js";
import type { Status, Target } from "./schedule.js";

/**
 * Called when a public target's status as seen from the outside changes (down after 3 failed checks, up after 2 passes).
 * The outside vantage has its own status and does not touch `monitor_targets.status`.
 */
export function onOutsideStatusChange(target: Target, status: Status, error: string | null, now: number): void {
  if (status !== "up" && status !== "down") return;
  applyStatusChange(target, { vantage: "outside", status, error }, now);
}
