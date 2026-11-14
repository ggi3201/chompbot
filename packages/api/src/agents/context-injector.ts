/**
 * Builds a small <context> block prepended to every agent prompt so that
 * whichever LLM CLI Chomp dispatches to (Claude Code, Codex, Gemini CLI, …)
 * has fresh date/time/location grounding without needing tool calls.
 *
 * Pulls the user's authoritative location from Home Assistant's iPhone
 * device tracker and derives the user-local timezone from lat/lon. Falls
 * back to server-local time when HA is unreachable or location is stale.
 */

import tzLookup from "tz-lookup";
import { fetchHaState, locationEntity } from "../location/home-assistant.js";

const HA_FETCH_TIMEOUT_MS = 250;
const STALE_LOCATION_MS = 30 * 60 * 1000; // 30 min

interface IPhoneState {
  state: string;
  attributes: {
    latitude?: number;
    longitude?: number;
    gps_accuracy?: number;
    friendly_name?: string;
  };
  last_updated: string;
}

interface GeocodedState {
  state: string;
}

function fmtInTz(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return f.format(d).replace(", ", " ");
}

function getServerTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function relativeMinutes(iso: string): { minutes: number; label: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return { minutes, label: "just now" };
  if (minutes < 60) return { minutes, label: `${minutes} min ago` };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { minutes, label: `${hours}h ago` };
  const days = Math.round(hours / 24);
  return { minutes, label: `${days}d ago` };
}

/**
 * Build the <context> block to prepend to user prompts. Always succeeds —
 * falls back to server-local time when HA is unreachable or stale.
 */
export async function getAgentContext(): Promise<string> {
  const now = new Date();
  const serverTz = getServerTz();
  const lines: string[] = [];

  lines.push(`date: ${now.toISOString().slice(0, 10)}`);
  lines.push(`server_time: ${fmtInTz(now, serverTz)} (${serverTz})`);

  const iphone = await fetchHaState<IPhoneState>(locationEntity() ?? "", HA_FETCH_TIMEOUT_MS);
  if (iphone) {
    const age = relativeMinutes(iphone.last_updated);
    const fresh = age && age.minutes * 60_000 < STALE_LOCATION_MS;

    if (fresh && iphone.attributes.latitude != null && iphone.attributes.longitude != null) {
      let userTz: string | null = null;
      try {
        userTz = tzLookup(iphone.attributes.latitude, iphone.attributes.longitude);
      } catch {
        userTz = null;
      }
      if (userTz && userTz !== serverTz) {
        lines.push(`user_time: ${fmtInTz(now, userTz)} (${userTz})`);
      }

      const geocoded = await fetchHaState<GeocodedState>(process.env.HOMEASSISTANT_GEOCODED_ENTITY?.trim() ?? "", HA_FETCH_TIMEOUT_MS);
      const place = geocoded?.state && geocoded.state !== "unavailable"
        ? geocoded.state.replace(/\n/g, ", ")
        : `${iphone.attributes.latitude.toFixed(4)}, ${iphone.attributes.longitude.toFixed(4)}`;
      const acc = iphone.attributes.gps_accuracy != null ? `, ±${iphone.attributes.gps_accuracy}m` : "";
      lines.push(`user_location: ${place} (${iphone.state}${acc}, ${age!.label})`);
    } else if (age) {
      lines.push(`user_location: stale (${age.label}, treating as unknown)`);
    }
  }

  return `<context>\n${lines.join("\n")}\n</context>\n\n`;
}
