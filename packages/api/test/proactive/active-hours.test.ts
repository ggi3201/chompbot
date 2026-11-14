import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isWithinActiveHours } from "../../src/proactive/engine.js";

const WINDOW = { start: 9, startMinute: 15, end: 9, timezone: "Europe/Oslo" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a 09:15 start in Oslo opens on its minute and closes at the end of the hour", () => {
  const cases = [
    ["2026-11-05T07:59:00Z", false],
    ["2026-11-05T08:14:00Z", false],
    ["2026-11-05T08:15:00Z", true],
    ["2026-11-05T08:59:00Z", true],
    ["2026-11-05T09:00:00Z", false],
  ] as const;
  for (const [now, expected] of cases) {
    vi.setSystemTime(new Date(now));
    expect(isWithinActiveHours(WINDOW), now).toBe(expected);
  }
});

test("a window without a start minute opens on the hour", () => {
  vi.setSystemTime(new Date("2026-11-05T08:00:00Z"));
  expect(isWithinActiveHours({ start: 9, end: 9, timezone: "Europe/Oslo" })).toBe(true);
});
