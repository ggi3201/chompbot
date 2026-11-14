import { afterEach, expect, test, vi } from "vitest";
import { isWithinActiveHours } from "../../src/proactive/engine.js";

const WINDOW = { start: 9, startMinute: 15, end: 9, timezone: "Europe/Oslo" };

afterEach(() => vi.useRealTimers());

test.each([
  ["2026-11-05T07:59:00Z", false],
  ["2026-11-05T08:14:00Z", false],
  ["2026-11-05T08:15:00Z", true],
  ["2026-11-05T08:59:00Z", true],
  ["2026-11-05T09:00:00Z", false],
])("a 09:15 start in Oslo at %s is %s", (now, expected) => {
  vi.useFakeTimers({ now: new Date(now) });
  expect(isWithinActiveHours(WINDOW)).toBe(expected);
});

test("a window without a start minute opens on the hour", () => {
  vi.useFakeTimers({ now: new Date("2026-11-05T08:00:00Z") });
  expect(isWithinActiveHours({ start: 9, end: 9, timezone: "Europe/Oslo" })).toBe(true);
});
