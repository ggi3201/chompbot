import { googleFetch } from "../agents/tools/google-common.js";
import { readPhoneCalendar, type PhoneSlot } from "../lib/phone-calendar.js";
import { getSecret } from "../lib/secrets.js";
import { getUserTimezone } from "../proactive/engine.js";
import { recallMemories } from "../db/memories.js";
const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;

export interface WeekItem {
  title: string;
  /** HH:mm local time. Absent for all-day items. */
  time?: string;
  kind: "event" | "match";
  crest?: string;
  detail?: string;
}

export interface WeekDay {
  date: string;
  items: WeekItem[];
}

export interface TravelItem {
  date: string;
  title: string;
  time?: string;
}

export interface CalendarEvent {
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

export interface Match {
  utcDate: string;
  homeTeam: { id: number; shortName: string; crest: string };
  awayTeam: { id: number; shortName: string; crest: string };
  competition?: { name: string };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function localDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** Seven days from `start`. All-day items come first in a day, then the rest by time. */
export function buildWeek(start: string, events: CalendarEvent[], matches: Match[], timezone: string, travel: TravelItem[] = [], teamId?: number): WeekDay[] {
  const days: WeekDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => ({ date: addDays(start, i), items: [] }));
  const dayOf = (date: string) => days.find((day) => day.date === date);

  for (const event of events) {
    const title = event.summary?.trim() || "Busy";
    if (event.start.dateTime) {
      dayOf(localDate(event.start.dateTime, timezone))?.items.push({ title, time: localTime(event.start.dateTime, timezone), kind: "event" });
    } else if (event.start.date) {
      // An all-day event's end date is exclusive, and it shows on every day it spans.
      for (let date = event.start.date; date < (event.end.date ?? addDays(event.start.date, 1)); date = addDays(date, 1)) {
        dayOf(date)?.items.push({ title, kind: "event" });
      }
    }
  }

  for (const match of matches) {
    const ours = match.homeTeam.id === teamId ? match.homeTeam : match.awayTeam;
    dayOf(localDate(match.utcDate, timezone))?.items.push({
      title: `${match.homeTeam.shortName} v ${match.awayTeam.shortName}`,
      time: localTime(match.utcDate, timezone),
      kind: "match",
      crest: ours.crest,
      detail: match.competition?.name,
    });
  }

  for (const { date, title, time } of travel) {
    dayOf(date)?.items.push({ title, ...(time ? { time } : {}), kind: "event" });
  }

  for (const day of days) {
    day.items.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  }
  return days;
}

async function fetchEvents(start: string): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    // A day wider than the week on both sides, so no timezone can clip it. buildWeek drops the rest.
    timeMin: `${addDays(start, -1)}T00:00:00Z`,
    timeMax: `${addDays(start, WEEK_DAYS + 1)}T00:00:00Z`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });
  const response = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  if (!response.ok) throw new Error(`Calendar responded ${response.status}`);
  return ((await response.json()) as { items?: CalendarEvent[] }).items ?? [];
}

/** The user's team from a preference memory such as "football_team: Brentford (football-data.org team id 402)". */
export function favouriteTeamId(): number | undefined {
  const pref = recallMemories({ category: "preferences", limit: 500 }).find((m) => /football_team/i.test(m.content));
  const id = pref?.content.match(/football_team[^\n]*?(\d{1,6})/i)?.[1];
  return id ? Number(id) : undefined;
}

async function fetchMatches(start: string, teamId: number | undefined): Promise<Match[]> {
  if (!teamId) return [];
  const params = new URLSearchParams({ dateFrom: addDays(start, -1), dateTo: addDays(start, WEEK_DAYS) });
  const response = await fetch(`https://api.football-data.org/v4/teams/${teamId}/matches?${params}`, {
    headers: { "X-Auth-Token": getSecret("FOOTBALL_DATA_KEY") ?? "" },
  });
  if (!response.ok) throw new Error(`Fixtures responded ${response.status}`);
  return ((await response.json()) as { matches?: Match[] }).matches ?? [];
}

/**
 * iPhone busy slots as untitled "Work"/"Private" events. The phone also carries the Gmail
 * calendar, so a slot with the same start and end as a Google event is left to Google's titled copy.
 */
export function phoneEvents(google: CalendarEvent[], slots: PhoneSlot[]): CalendarEvent[] {
  const known = new Set(google.map((e) => `${Date.parse(e.start.dateTime ?? "")}|${Date.parse(e.end.dateTime ?? "")}`));
  return slots
    .filter((s) => s.allDay || !known.has(`${Date.parse(s.start)}|${Date.parse(s.end)}`))
    .map((s) => ({
      summary: s.kind === "work" ? "Work" : "Private",
      // The phone gives an all-day event as local midnight to 23:59:59; Google's end date is exclusive.
      start: s.allDay ? { date: s.start.slice(0, 10) } : { dateTime: s.start },
      end: s.allDay ? { date: addDays(s.end.slice(0, 10), 1) } : { dateTime: s.end },
    }));
}

/** The week as it stands right now. A source that fails is named, so the page never passes off a gap as a free day. */
const withPhone = (google: CalendarEvent[]) => [...google, ...phoneEvents(google, readPhoneCalendar()?.slots ?? [])];

export async function loadWeek(start: string, travel: TravelItem[] = []): Promise<{ days: WeekDay[]; missing: string[] }> {
  const teamId = favouriteTeamId();
  const [events, matches] = await Promise.allSettled([fetchEvents(start), fetchMatches(start, teamId)]);
  const missing = [
    ...(events.status === "rejected" ? ["calendar"] : []),
    ...(matches.status === "rejected" ? ["fixtures"] : []),
  ];
  return {
    days: buildWeek(start, withPhone(events.status === "fulfilled" ? events.value : []), matches.status === "fulfilled" ? matches.value : [], getUserTimezone(), travel, teamId),
    missing,
  };
}
