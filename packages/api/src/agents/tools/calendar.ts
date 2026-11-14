/**
 * Calendar tools — list and create events via the Google Calendar API.
 */

import { phoneBusyText } from "../../lib/phone-calendar.js";
import { googleFetch } from "./google-common.js";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

// ── Date helpers ────────────────────────────────────────────────

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfToday(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function formatEventTime(t: { dateTime?: string; date?: string }): string {
  if (t.dateTime) {
    return new Date(t.dateTime).toLocaleString();
  }
  return t.date ?? "unknown";
}

function formatRange(isoMin: string, isoMax: string): string {
  try {
    const min = new Date(isoMin);
    const max = new Date(isoMax);
    const sameDay = min.toDateString() === max.toDateString();
    if (sameDay) {
      return `${min.toLocaleDateString()} ${min.toLocaleTimeString()} – ${max.toLocaleTimeString()}`;
    }
    return `${min.toLocaleString()} – ${max.toLocaleString()}`;
  } catch {
    return `${isoMin} – ${isoMax}`;
  }
}

/**
 * Coerce model-provided date strings into RFC 3339 that Google accepts.
 * Key: always produce a string with timezone info (Z or +/-offset).
 */
function normalizeDateTime(input: string): string {
  // Already has timezone info (Z or +/-offset) — pass through
  if (/^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:\d{2})$/.test(input)) return input;

  // ISO-like but missing timezone (e.g. "2025-07-15T14:00:00") — parse and convert to UTC
  if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  // Try native Date parsing (handles "2025-01-15", "Jan 15 2025 2pm", etc.)
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();

  // Give up — return as-is and let the API error be descriptive
  return input;
}

// ── List Events ─────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  htmlLink?: string;
}

interface CalendarListResponse {
  items?: CalendarEvent[];
}

export async function execListEvents(timeMin?: string, timeMax?: string, maxResults?: number): Promise<string> {
  const resolvedMin = timeMin ? normalizeDateTime(timeMin) : startOfToday();
  const resolvedMax = timeMax ? normalizeDateTime(timeMax) : endOfToday();
  // The work calendars live only on the iPhone, so add its busy times even when Google fails.
  const phone = phoneBusyText(resolvedMin, resolvedMax);
  const google = await listGoogleEvents(resolvedMin, resolvedMax, maxResults);
  return phone ? `${google}\n\n${phone}` : google;
}

async function listGoogleEvents(resolvedMin: string, resolvedMax: string, maxResults?: number): Promise<string> {

  const params = new URLSearchParams({
    timeMin: resolvedMin,
    timeMax: resolvedMax,
    maxResults: String(Math.min(maxResults ?? 10, 25)),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await googleFetch(`${CALENDAR_BASE}/events?${params}`);
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    if (res.status === 400) {
      return `ERROR: Google Calendar rejected the request (bad date format?). Dates must be ISO 8601 like "2025-07-15T14:00:00". Got timeMin="${resolvedMin}", timeMax="${resolvedMax}". Raw error: ${err.slice(0, 200)}`;
    }
    return `ERROR: Calendar list failed (${res.status}): ${err.slice(0, 200)}`;
  }

  const data = await res.json() as CalendarListResponse;
  const range = formatRange(resolvedMin, resolvedMax);

  if (!data.items || data.items.length === 0) {
    return `Success: Calendar checked for ${range} — no events scheduled. The calendar is clear for this period.`;
  }

  const header = `Found ${data.items.length} event(s) for ${range}:\n`;
  const events = data.items.map((e) => {
    const lines = [`- ${e.summary ?? "(no title)"}`];
    lines.push(`  Time: ${formatEventTime(e.start)} — ${formatEventTime(e.end)}`);
    if (e.location) lines.push(`  Location: ${e.location}`);
    if (e.description) {
      const snippet = e.description.length > 100 ? e.description.slice(0, 100) + "..." : e.description;
      lines.push(`  Description: ${snippet}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  return header + events;
}

// ── Create Event ────────────────────────────────────────────────

interface CreatedEvent {
  id: string;
  htmlLink: string;
  summary: string;
}

export async function execCreateEvent(
  summary: string,
  startTime: string,
  endTime: string,
  description?: string,
  location?: string,
  timezone?: string,
): Promise<string> {
  const tz = timezone ?? process.env.TZ ?? "UTC";
  const normalizedStart = normalizeDateTime(startTime);
  const normalizedEnd = normalizeDateTime(endTime);

  const event = {
    summary,
    start: { dateTime: normalizedStart, timeZone: tz },
    end: { dateTime: normalizedEnd, timeZone: tz },
    ...(description && { description }),
    ...(location && { location }),
  };

  const res = await googleFetch(`${CALENDAR_BASE}/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    if (res.status === 400) {
      return `ERROR: Google Calendar rejected the event. Check date formats — must be ISO 8601 like "2025-07-15T14:00:00". Got start="${normalizedStart}", end="${normalizedEnd}". Raw error: ${err.slice(0, 200)}`;
    }
    return `ERROR: Failed to create event (${res.status}): ${err.slice(0, 200)}`;
  }

  const created = await res.json() as CreatedEvent;
  return `Success: Event created — "${created.summary}"\nLink: ${created.htmlLink}\nID: ${created.id}`;
}
