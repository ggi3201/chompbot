import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

/**
 * Busy slots synced from the iPhone's calendars by a Shortcut that posts to the
 * webhook named PHONE_CALENDAR_WEBHOOK. The phone sends only start, end and
 * calendar name per event (never titles), one per line: `start|end|calendar|allDay`.
 * Kept on disk because Chomp restarts on every deploy.
 */
export const PHONE_CALENDAR_WEBHOOK = "iphone-calendar";

// Calendar names are matched case-insensitively; empty overrides disable a list.
const calendarNames = (key: string, fallback: string) =>
  new Set((process.env[key] ?? fallback).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));

export interface PhoneSlot { start: string; end: string; kind: "work" | "private"; allDay: boolean }
interface Snapshot { syncedAt: string; slots: PhoneSlot[] }

const file = () => resolve(process.env.PHONE_CALENDAR_FILE ?? "./data/phone-calendar.json");

export function parsePhoneCalendar(text: string): PhoneSlot[] {
  const work = calendarNames("PHONE_CALENDAR_WORK_NAMES", "calendar");
  const skip = calendarNames("PHONE_CALENDAR_SKIP_NAMES", "birthdays,holidays");
  const slots: PhoneSlot[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [start, end, calendar = "", allDay = ""] = line.split("|").map((part) => part.trim());
    const name = calendar.toLowerCase();
    if (!start || !end || skip.has(name) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) continue;
    slots.push({ start, end, kind: work.has(name) ? "work" : "private", allDay: /^(yes|true|1|ja)$/i.test(allDay) });
  }
  return slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Accepts `{events: "<lines>"}` (what the Shortcut sends) or the raw lines. */
export function savePhoneCalendar(body: unknown): number {
  const text = typeof body === "string" ? body : (body as { events?: unknown } | null)?.events;
  if (typeof text !== "string") return 0;
  const slots = parsePhoneCalendar(text);
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify({ syncedAt: new Date().toISOString(), slots } satisfies Snapshot, null, 2));
  return slots.length;
}

const formatTime = (iso: string, withDay: boolean) =>
  new Date(iso).toLocaleString("en-GB", {
    timeZone: process.env.PHONE_CALENDAR_TIMEZONE || "UTC", hour: "2-digit", minute: "2-digit",
    ...(withDay && { weekday: "short", day: "numeric", month: "short" }),
  });

/** A text block of phone busy slots overlapping [timeMin, timeMax], or "" when there is no snapshot. */
export function readPhoneCalendar(): Snapshot | null {
  return existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Snapshot) : null;
}

export function phoneBusyText(timeMin: string, timeMax: string): string {
  const snapshot = readPhoneCalendar();
  if (!snapshot) return "";
  const { syncedAt, slots } = snapshot;
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  const hits = slots.filter((s) => Date.parse(s.start) < max && Date.parse(s.end) > min);
  const header = `iPhone calendars, busy times only (no titles), synced ${formatTime(syncedAt, true)}:`;
  if (hits.length === 0) return `${header}\n- nothing busy in this window`;
  return [header, ...hits.map((s) =>
    s.allDay ? `- ${formatTime(s.start, true).split(",")[0]} all day: ${s.kind}` : `- ${formatTime(s.start, true)} to ${formatTime(s.end, false)}: ${s.kind}`,
  )].join("\n");
}
