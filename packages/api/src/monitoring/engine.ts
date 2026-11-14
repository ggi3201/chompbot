import { runCheck, type CheckResult } from "./checks.js";
import { syncIncident } from "./incidents.js";
import { isCheckable, isDue, type Target } from "./schedule.js";
import { activeTargets, recordPushArrival, recordResult } from "./store.js";

const CONCURRENCY = 10;

/** Stores a result, moves the target's status and keeps its incident in line. */
export function applyResult(target: Target, result: CheckResult, now: number) {
  const { previous, status } = recordResult(target, result, now);
  syncIncident(target, status, result.error, now);
  return { previous, status };
}

/** A push job speaks for itself: "down" is a failed check at once, without waiting for silence. */
export function applyPush(target: Target, push: { ok: boolean; msg: string | null; latencyMs: number | null }, now: number) {
  const updated = recordPushArrival(target.key, push, now);
  return applyResult(updated, { ok: push.ok, statusCode: null, latencyMs: push.latencyMs, error: push.ok ? null : push.msg ?? "Job reported down" }, now);
}

/** Runs the checks, at most CONCURRENCY at a time. A failing probe never stops the rest. */
async function runChecks(targets: Target[], now: number): Promise<number> {
  const queue = [...targets];
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      try {
        applyResult(target, await runCheck(target, now), now);
      } catch (err) {
        console.error(`[monitoring] check of ${target.key} failed:`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return targets.length;
}

export const runDueChecks = (now = Date.now()) => runChecks(activeTargets().filter((target) => isDue(target, now)), now);

/** Every check now, due or not, for Refresh on the page. */
export const runAllChecks = (now = Date.now()) => runChecks(activeTargets().filter(isCheckable), now);
