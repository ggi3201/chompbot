import type { monitorTargets } from "../db/schema.js";

export type Target = typeof monitorTargets.$inferSelect;
export type Status = Target["status"];

export const TRACKED_INTERVAL_SEC = 60;
export const UNTRACKED_INTERVAL_SEC = 300;
/** A push job may be this late before it counts as silent. */
export const PUSH_GRACE_SEC = 60;
/** A host that has not reported for this long is down. */
export const HOST_FRESH_MS = 3 * 60_000;
export const CHECKED_KINDS: readonly Target["kind"][] = ["http", "tcp", "ping", "push", "container", "host"];

export const checkIntervalSec = (target: Pick<Target, "kind" | "tracked">) =>
  target.kind === "push" || target.tracked ? TRACKED_INTERVAL_SEC : UNTRACKED_INTERVAL_SEC;

export const isCheckable = (target: Pick<Target, "kind" | "retiredAt">) => !target.retiredAt && CHECKED_KINDS.includes(target.kind);

export function isDue(target: Pick<Target, "kind" | "tracked" | "lastCheckedAt" | "retiredAt">, now: number): boolean {
  if (!isCheckable(target)) return false;
  return target.lastCheckedAt === null || now - target.lastCheckedAt >= checkIntervalSec(target) * 1000;
}

/** Checks are overdue after three missed intervals: a green dot from a checker that stopped would be a lie. */
export const isStale = (target: Pick<Target, "kind" | "tracked" | "lastCheckedAt">, now: number) =>
  target.lastCheckedAt === null || now - target.lastCheckedAt > checkIntervalSec(target) * 3000;

interface Thresholds { down: number; up: number }
const DEFAULT_THRESHOLDS: Thresholds = { down: 3, up: 2 };
// A push job's deadline and a host's freshness window already include their grace, so one verdict is enough.
const DEADLINE_THRESHOLDS: Thresholds = { down: 1, up: 1 };

export const thresholdsFor = (kind: Target["kind"]) => (kind === "push" || kind === "host" ? DEADLINE_THRESHOLDS : DEFAULT_THRESHOLDS);

/**
 * Down after `down` failures in a row, up after `up` passes in a row, as Kuma's retries did.
 * `recent` holds the latest results, newest first. A target with no verdict yet needs one pass only.
 */
export function nextStatus(current: Status, recent: readonly boolean[], thresholds: Thresholds = DEFAULT_THRESHOLDS): Status {
  const upAfter = current === "unknown" ? 1 : thresholds.up;
  const failing = recent.length >= thresholds.down && recent.slice(0, thresholds.down).every((ok) => !ok);
  const passing = recent.length >= upAfter && recent.slice(0, upAfter).every(Boolean);
  if (failing && current !== "down") return "down";
  if (passing && current !== "up") return "up";
  return current;
}

/** The moment a push job turns silent. Before its first push it counts from when it was created. */
export function pushDeadline(target: Pick<Target, "lastPushAt" | "firstSeen" | "pushIntervalSec">): number {
  const since = target.lastPushAt ?? Date.parse(target.firstSeen);
  return since + ((target.pushIntervalSec ?? 86_400) + PUSH_GRACE_SEC) * 1000;
}
