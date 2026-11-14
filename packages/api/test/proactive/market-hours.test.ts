import { expect, test } from "vitest";
import { explainScheduleGuard, isWithinScheduleGuard } from "../../src/proactive/market-hours.js";

test("schedule guard is opt-in", () => {
  expect(isWithinScheduleGuard(undefined, new Date("2026-05-24T14:00:00Z"))).toBe(true);
});

test("NASDAQ regular session skips Sunday and allows regular cash hours", () => {
  const guard = { rules: [{ type: "market_session" as const, market: "XNAS" as const, phase: "regular" as const }] };

  expect(isWithinScheduleGuard(guard, new Date("2026-05-24T14:00:00Z"))).toBe(false);
  expect(isWithinScheduleGuard(guard, new Date("2026-05-22T15:00:00Z"))).toBe(true);
  expect(isWithinScheduleGuard(guard, new Date("2026-05-22T21:00:00Z"))).toBe(false);
  expect(explainScheduleGuard(guard, new Date("2026-05-24T14:00:00Z"))).toContain("closed on Sun");
  expect(explainScheduleGuard(guard, new Date("2026-05-22T15:00:00Z"))).toBeUndefined();
});

test("NASDAQ guard handles trading-day and after-close phases", () => {
  expect(isWithinScheduleGuard(
    { rules: [{ type: "market_session", market: "NASDAQ", phase: "trading_day" }] },
    new Date("2026-05-22T08:00:00Z"),
  )).toBe(true);

  expect(isWithinScheduleGuard(
    { rules: [{ type: "market_session", market: "NASDAQ", phase: "after_close" }] },
    new Date("2026-05-22T21:00:00Z"),
  )).toBe(true);
});

test("market schedule guard skips US market holidays", () => {
  expect(isWithinScheduleGuard(
    { rules: [{ type: "market_session", market: "NYSE", phase: "regular" }] },
    new Date("2026-12-25T15:00:00Z"),
  )).toBe(false);
});

test("Oslo market guard skips Norwegian exchange holidays", () => {
  expect(isWithinScheduleGuard(
    { rules: [{ type: "market_session", market: "XOSL", phase: "regular" }] },
    new Date("2026-05-14T10:00:00Z"),
  )).toBe(false);
});

test("generic guard supports weekday, date range, and any mode", () => {
  expect(isWithinScheduleGuard(
    { rules: [{ type: "weekday", timezone: "Europe/Oslo", days: ["Sun"] }] },
    new Date("2026-05-24T14:00:00Z"),
  )).toBe(true);

  expect(isWithinScheduleGuard(
    { rules: [{ type: "date_range", startsAt: "2026-05-24T00:00:00Z", endsAt: "2026-05-25T00:00:00Z" }] },
    new Date("2026-05-24T14:00:00Z"),
  )).toBe(true);

  expect(isWithinScheduleGuard(
    {
      mode: "any",
      rules: [
        { type: "weekday", timezone: "Europe/Oslo", days: ["Mon"] },
        { type: "date_range", startsAt: "2026-05-24T00:00:00Z", endsAt: "2026-05-25T00:00:00Z" },
      ],
    },
    new Date("2026-05-24T14:00:00Z"),
  )).toBe(true);
});

test("schedule guard explains non-market guard misses", () => {
  expect(explainScheduleGuard(
    { rules: [{ type: "weekday", timezone: "Europe/Oslo", days: ["Mon"] }] },
    new Date("2026-05-24T14:00:00Z"),
  )).toContain("allowed days: Mon");

  expect(explainScheduleGuard(
    { rules: [{ type: "date_range", startsAt: "2026-05-25T00:00:00Z" }] },
    new Date("2026-05-24T14:00:00Z"),
  )).toContain("starts at 2026-05-25T00:00:00Z");
});
