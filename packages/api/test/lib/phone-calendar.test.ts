import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parsePhoneCalendar, phoneBusyText, savePhoneCalendar } from "../../src/lib/phone-calendar.js";

process.env.PHONE_CALENDAR_FILE = join(mkdtempSync(join(tmpdir(), "phone-cal-")), "phone-calendar.json");

beforeEach(() => {
  vi.stubEnv("PHONE_CALENDAR_SKIP_NAMES", "birthdays,sports");
  vi.stubEnv("PHONE_CALENDAR_TIMEZONE", "Europe/Oslo");
});
afterEach(() => vi.unstubAllEnvs());

const lines = [
  "2026-11-10T09:00:00+01:00|2026-11-10T10:00:00+01:00|Calendar|No",
  "2026-11-10T12:00:00+01:00|2026-11-10T13:00:00+01:00|Family|No",
  "2026-11-10T00:00:00+01:00|2026-11-11T00:00:00+01:00|Birthdays|Yes",
  "2026-11-10T20:00:00+01:00|2026-11-10T22:00:00+01:00|Sports|No",
  "garbage line",
].join("\n");

test("labels work and private calendars and drops non-busy ones; work and skip names are configurable", () => {
  expect(parsePhoneCalendar(lines).map((s) => s.kind)).toEqual(["work", "private"]);

  vi.stubEnv("PHONE_CALENDAR_WORK_NAMES", " Family, Work@example.com ");
  expect(parsePhoneCalendar(lines).map((slot) => slot.kind)).toEqual(["private", "work"]);

  vi.stubEnv("PHONE_CALENDAR_SKIP_NAMES", "");
  expect(parsePhoneCalendar(lines)).toHaveLength(4);
});

test("lists only slots inside the window, without titles", () => {
  expect(savePhoneCalendar({ events: lines })).toBe(2);
  const text = phoneBusyText("2026-11-10T08:00:00+01:00", "2026-11-10T11:00:00+01:00");
  expect(text).toContain("09:00 to 10:00: work");
  expect(text).not.toContain("private");
  expect(phoneBusyText("2026-11-12T00:00:00Z", "2026-11-13T00:00:00Z")).toContain("nothing busy");
});

test("busy text uses the configured timezone", () => {
  vi.stubEnv("PHONE_CALENDAR_TIMEZONE", "UTC");
  savePhoneCalendar({ events: lines });
  expect(phoneBusyText("2026-11-10T08:00:00+01:00", "2026-11-10T11:00:00+01:00")).toContain("08:00 to 09:00: work");
});
