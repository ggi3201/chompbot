import type { MarketCode, MarketSchedulePhase, MarketSessionGuardRule, ScheduleGuard, ScheduleGuardRule } from "./rule-model.js";

type MarketDefinition = {
  timezone: string;
  regularOpenMinutes: number;
  regularCloseMinutes: number;
  holidayCalendar: "us" | "oslo";
};

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: string;
  minutes: number;
};

const MARKET_DEFINITIONS: Record<MarketCode, MarketDefinition> = {
  NYSE: { timezone: "America/New_York", regularOpenMinutes: 9 * 60 + 30, regularCloseMinutes: 16 * 60, holidayCalendar: "us" },
  XNYS: { timezone: "America/New_York", regularOpenMinutes: 9 * 60 + 30, regularCloseMinutes: 16 * 60, holidayCalendar: "us" },
  NASDAQ: { timezone: "America/New_York", regularOpenMinutes: 9 * 60 + 30, regularCloseMinutes: 16 * 60, holidayCalendar: "us" },
  XNAS: { timezone: "America/New_York", regularOpenMinutes: 9 * 60 + 30, regularCloseMinutes: 16 * 60, holidayCalendar: "us" },
  OSLO: { timezone: "Europe/Oslo", regularOpenMinutes: 9 * 60, regularCloseMinutes: 16 * 60 + 20, holidayCalendar: "oslo" },
  XOSL: { timezone: "Europe/Oslo", regularOpenMinutes: 9 * 60, regularCloseMinutes: 16 * 60 + 20, holidayCalendar: "oslo" },
};

function getZonedParts(now: Date, timezone: string): ZonedDateParts | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      weekday: String(parts.weekday),
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  } catch {
    return null;
  }
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(year: number, month: number, day: number, offset: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const delta = (weekday - first + 7) % 7;
  return 1 + delta + (nth - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDate = new Date(Date.UTC(year, month, 0));
  const delta = (lastDate.getUTCDay() - weekday + 7) % 7;
  return lastDate.getUTCDate() - delta;
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0) {
    const observed = addDays(year, month, day, 1);
    return dateKey(observed.year, observed.month, observed.day);
  }
  if (weekday === 6) {
    const observed = addDays(year, month, day, -1);
    return dateKey(observed.year, observed.month, observed.day);
  }
  return dateKey(year, month, day);
}

function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function usMarketHolidayKeys(year: number): Set<string> {
  const easter = easterSunday(year);
  const goodFriday = addDays(year, easter.month, easter.day, -2);
  return new Set([
    observedFixedHoliday(year, 1, 1),
    dateKey(year, 1, nthWeekdayOfMonth(year, 1, 1, 3)),
    dateKey(year, 2, nthWeekdayOfMonth(year, 2, 1, 3)),
    dateKey(goodFriday.year, goodFriday.month, goodFriday.day),
    dateKey(year, 5, lastWeekdayOfMonth(year, 5, 1)),
    observedFixedHoliday(year, 6, 19),
    observedFixedHoliday(year, 7, 4),
    dateKey(year, 9, nthWeekdayOfMonth(year, 9, 1, 1)),
    dateKey(year, 11, nthWeekdayOfMonth(year, 11, 4, 4)),
    observedFixedHoliday(year, 12, 25),
    // Handles New Year's Day observed on Dec 31 of the previous calendar year.
    observedFixedHoliday(year + 1, 1, 1),
  ]);
}

function osloMarketHolidayKeys(year: number): Set<string> {
  const easter = easterSunday(year);
  const maundyThursday = addDays(year, easter.month, easter.day, -3);
  const goodFriday = addDays(year, easter.month, easter.day, -2);
  const easterMonday = addDays(year, easter.month, easter.day, 1);
  const ascension = addDays(year, easter.month, easter.day, 39);
  const whitMonday = addDays(year, easter.month, easter.day, 50);
  return new Set([
    dateKey(year, 1, 1),
    dateKey(maundyThursday.year, maundyThursday.month, maundyThursday.day),
    dateKey(goodFriday.year, goodFriday.month, goodFriday.day),
    dateKey(easterMonday.year, easterMonday.month, easterMonday.day),
    dateKey(year, 5, 1),
    dateKey(year, 5, 17),
    dateKey(ascension.year, ascension.month, ascension.day),
    dateKey(whitMonday.year, whitMonday.month, whitMonday.day),
    dateKey(year, 12, 24),
    dateKey(year, 12, 25),
    dateKey(year, 12, 26),
    dateKey(year, 12, 31),
  ]);
}

function isTradingHoliday(parts: ZonedDateParts, calendar: MarketDefinition["holidayCalendar"]): boolean {
  const key = dateKey(parts.year, parts.month, parts.day);
  const holidays = calendar === "us" ? usMarketHolidayKeys(parts.year) : osloMarketHolidayKeys(parts.year);
  return holidays.has(key);
}

function normalizePhase(phase: MarketSchedulePhase | undefined): MarketSchedulePhase {
  return phase ?? "regular";
}

function describeMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function evaluateMarketSession(rule: MarketSessionGuardRule, now: Date): { matched: boolean; reason?: string } {
  const market = MARKET_DEFINITIONS[rule.market];
  if (!market) return { matched: false, reason: `Unknown market ${rule.market}` };
  const parts = getZonedParts(now, market.timezone);
  if (!parts) return { matched: false, reason: `Could not read time in ${market.timezone}` };
  const date = dateKey(parts.year, parts.month, parts.day);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") {
    return { matched: false, reason: `${rule.market} is closed on ${parts.weekday} ${date}` };
  }
  if (isTradingHoliday(parts, market.holidayCalendar)) {
    return { matched: false, reason: `${rule.market} is closed for a market holiday on ${date}` };
  }

  const phase = normalizePhase(rule.phase);
  if (phase === "trading_day") return { matched: true };
  if (phase === "after_close") {
    if (parts.minutes >= market.regularCloseMinutes) return { matched: true };
    return {
      matched: false,
      reason: `${rule.market} after-close guard blocked at ${describeMinutes(parts.minutes)} ${market.timezone}; close is ${describeMinutes(market.regularCloseMinutes)}`,
    };
  }
  if (parts.minutes >= market.regularOpenMinutes && parts.minutes < market.regularCloseMinutes) return { matched: true };
  return {
    matched: false,
    reason: `${rule.market} regular-session guard blocked at ${describeMinutes(parts.minutes)} ${market.timezone}; session is ${describeMinutes(market.regularOpenMinutes)}-${describeMinutes(market.regularCloseMinutes)}`,
  };
}

function isWithinMarketSession(rule: MarketSessionGuardRule, now: Date): boolean {
  return evaluateMarketSession(rule, now).matched;
}

function evaluateDateRange(rule: Extract<ScheduleGuardRule, { type: "date_range" }>, now: Date): { matched: boolean; reason?: string } {
  const time = now.getTime();
  if (rule.startsAt !== undefined && time < Date.parse(rule.startsAt)) {
    return { matched: false, reason: `Date-range guard starts at ${rule.startsAt}` };
  }
  if (rule.endsAt !== undefined && time > Date.parse(rule.endsAt)) {
    return { matched: false, reason: `Date-range guard ended at ${rule.endsAt}` };
  }
  return { matched: true };
}

function isWithinDateRange(rule: Extract<ScheduleGuardRule, { type: "date_range" }>, now: Date): boolean {
  return evaluateDateRange(rule, now).matched;
}

function evaluateWeekday(rule: Extract<ScheduleGuardRule, { type: "weekday" }>, now: Date): { matched: boolean; reason?: string } {
  const timezone = rule.timezone ?? "UTC";
  const parts = getZonedParts(now, timezone);
  if (!parts) return { matched: false, reason: `Could not read weekday in ${timezone}` };
  if (rule.days.includes(parts.weekday as (typeof rule.days)[number])) return { matched: true };
  return { matched: false, reason: `Weekday guard blocked on ${parts.weekday} in ${timezone}; allowed days: ${rule.days.join(", ")}` };
}

function isWithinWeekday(rule: Extract<ScheduleGuardRule, { type: "weekday" }>, now: Date): boolean {
  return evaluateWeekday(rule, now).matched;
}

function evaluateGuardRuleWithReason(rule: ScheduleGuardRule, now: Date): { matched: boolean; reason?: string } {
  if (rule.type === "market_session") return evaluateMarketSession(rule, now);
  if (rule.type === "date_range") return evaluateDateRange(rule, now);
  return evaluateWeekday(rule, now);
}

function evaluateGuardRule(rule: ScheduleGuardRule, now: Date): boolean {
  return evaluateGuardRuleWithReason(rule, now).matched;
}

export function isWithinScheduleGuard(guard: ScheduleGuard | undefined, now = new Date()): boolean {
  if (!guard) return true;
  if (guard.mode === "any") return guard.rules.some((rule) => evaluateGuardRule(rule, now));
  return guard.rules.every((rule) => evaluateGuardRule(rule, now));
}

export function explainScheduleGuard(guard: ScheduleGuard | undefined, now = new Date()): string | undefined {
  if (!guard) return undefined;
  const evaluations = guard.rules.map((rule) => evaluateGuardRuleWithReason(rule, now));
  const mode = guard.mode ?? "all";
  const matched = mode === "any"
    ? evaluations.some((result) => result.matched)
    : evaluations.every((result) => result.matched);
  if (matched) return undefined;

  const reasons = evaluations
    .filter((result) => !result.matched && result.reason)
    .map((result) => result.reason);
  if (reasons.length === 0) return `Schedule guard (${mode}) did not match`;
  return `Schedule guard (${mode}) blocked: ${reasons.join("; ")}`;
}
