import { expect, test } from "vitest";
import { checkIntervalSec, isDue, isStale, nextStatus, pushDeadline, thresholdsFor } from "../../src/monitoring/schedule.js";

// Results are newest first.
const T = false;
const P = true;

test("down after three failures in a row, and not before", () => {
  expect(nextStatus("up", [T, T, P])).toBe("up");
  expect(nextStatus("up", [T, T])).toBe("up");
  expect(nextStatus("up", [T, T, T])).toBe("down");
  expect(nextStatus("up", [T, P, T, T])).toBe("up");
  expect(nextStatus("up", [P, P, P])).toBe("up");
});

test("a down target needs two passes in a row to come back", () => {
  expect(nextStatus("down", [P, T, T])).toBe("down");
  expect(nextStatus("down", [P, P, T])).toBe("up");
  expect(nextStatus("down", [T, P, P])).toBe("down");
  expect(nextStatus("down", [T, T, T, T])).toBe("down");
});

test("a target with no verdict yet is up after one pass, but down only after three failures", () => {
  expect(nextStatus("unknown", [P])).toBe("up");
  expect(nextStatus("unknown", [T])).toBe("unknown");
  expect(nextStatus("unknown", [T, T])).toBe("unknown");
  expect(nextStatus("unknown", [T, T, T])).toBe("down");
});

test("a push job is judged on its latest word alone", () => {
  expect(nextStatus("up", [T], thresholdsFor("push"))).toBe("down");
  expect(nextStatus("down", [P], thresholdsFor("push"))).toBe("up");
});

test("a target is due once its interval has passed since the last check (60 s tracked or push, 5 min untracked), or when it never ran", () => {
  expect(checkIntervalSec({ kind: "push", tracked: false })).toBe(60);
  const target = { kind: "http", tracked: true, retiredAt: null } as const;
  const now = 1_000_000;
  expect(isDue({ ...target, lastCheckedAt: null }, now)).toBe(true);
  expect(isDue({ ...target, lastCheckedAt: now - 59_999 }, now)).toBe(false);
  expect(isDue({ ...target, lastCheckedAt: now - 60_000 }, now)).toBe(true);
  expect(isDue({ ...target, tracked: false, lastCheckedAt: now - 120_000 }, now)).toBe(false);
  expect(isDue({ ...target, tracked: false, lastCheckedAt: now - 300_000 }, now)).toBe(true);
});

test("retired targets are never due, and hosts are checked from their reports", () => {
  const now = 1_000_000;
  expect(isDue({ kind: "http", tracked: true, retiredAt: "2026-11-01", lastCheckedAt: null }, now)).toBe(false);
  expect(isDue({ kind: "host", tracked: true, retiredAt: "2026-11-01", lastCheckedAt: null }, now)).toBe(false);
  expect(isDue({ kind: "host", tracked: true, retiredAt: null, lastCheckedAt: null }, now)).toBe(true);
  expect(isDue({ kind: "container", tracked: false, retiredAt: null, lastCheckedAt: null }, now)).toBe(true);
});

test("a target is stale after three missed intervals", () => {
  const target = { kind: "http", tracked: true } as const;
  const now = 1_000_000;
  expect(isStale({ ...target, lastCheckedAt: now - 180_000 }, now)).toBe(false);
  expect(isStale({ ...target, lastCheckedAt: now - 180_001 }, now)).toBe(true);
  expect(isStale({ ...target, lastCheckedAt: null }, now)).toBe(true);
});

test("a push job turns silent one interval plus the grace after its last push, or after its creation", () => {
  const pushed = { lastPushAt: 1_000_000, firstSeen: "2026-01-01T00:00:00.000Z", pushIntervalSec: 600 };
  expect(pushDeadline(pushed)).toBe(1_000_000 + 660_000);
  const never = { lastPushAt: null, firstSeen: "2026-11-08T12:00:00.000Z", pushIntervalSec: 600 };
  expect(pushDeadline(never)).toBe(Date.parse("2026-11-08T12:11:00.000Z"));
});
