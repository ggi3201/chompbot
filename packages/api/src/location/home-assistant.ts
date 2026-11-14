/**
 * Follows the iPhone's device tracker over Home Assistant's WebSocket API. The phone
 * watches the zones itself, and Home Assistant pushes each change here, so nothing polls.
 * The tracker is read again on every connect, to catch moves made while Chomp restarted.
 */
import WebSocket from "ws";
import { getSecret } from "../lib/secrets.js";
import { ingestLocation, reportSchema } from "./store.js";

export const locationEntity = () => process.env.HOMEASSISTANT_LOCATION_ENTITY?.trim() || null;

const HOME_PLACE = "Home";
const RECONNECT_MS = 60_000;
const PING_MS = 60_000;

interface TrackerState {
  state: string;
  attributes: { latitude?: number; longitude?: number; gps_accuracy?: number };
  last_updated: string;
}

export function haConfig(): { url: string; token: string } | null {
  const url = getSecret("HOMEASSISTANT_URL") ?? process.env.HOMEASSISTANT_URL;
  const token = getSecret("HOMEASSISTANT_TOKEN") ?? process.env.HOMEASSISTANT_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export async function fetchHaState<T>(entityId: string, timeoutMs: number): Promise<T | null> {
  const ha = haConfig();
  if (!ha || !entityId) return null;
  try {
    const res = await fetch(`${ha.url}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${ha.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** The zones in Home Assistant. Throws when it cannot be reached. */
export async function listPlaces(): Promise<Place[]> {
  const ha = haConfig();
  if (!ha) throw new Error("Home Assistant is not configured");
  const res = await fetch(`${ha.url}/api/states`, {
    headers: { Authorization: `Bearer ${ha.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Home Assistant returned ${res.status}`);
  const states = (await res.json()) as Array<{ entity_id: string; attributes: Record<string, unknown> }>;
  return states.filter((state) => state.entity_id.startsWith("zone.")).map(({ entity_id, attributes }) => ({
    name: entity_id === "zone.home" ? HOME_PLACE : String(attributes.friendly_name),
    latitude: Number(attributes.latitude),
    longitude: Number(attributes.longitude),
    radiusMeters: Number(attributes.radius),
  }));
}

/** A tracker's state is a zone name, or says it is in none. Unknown says nothing about places. */
function placeOf(state: string): string | null | undefined {
  if (state === "home") return HOME_PLACE;
  if (state === "not_home") return null;
  if (state === "unknown" || state === "unavailable") return undefined;
  return state;
}

function ingestTracker(tracker: TrackerState): void {
  const { latitude, longitude, gps_accuracy: accuracyMeters = 0 } = tracker.attributes;
  const report = reportSchema.safeParse({
    source: "home-assistant", latitude, longitude, accuracyMeters, place: placeOf(tracker.state), capturedAt: tracker.last_updated,
  });
  if (report.success) ingestLocation(report.data);
}

/** Returns a function that stops following. Waits quietly until Home Assistant is configured. */
export function startHomeAssistantLocation(): () => void {
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;

  function connect() {
    const ha = haConfig();
    const entity = locationEntity();
    if (!ha || !entity) {
      retry = setTimeout(connect, RECONNECT_MS);
      return;
    }

    const ws = new WebSocket(`${ha.url.replace(/^http/, "ws")}/api/websocket`);
    socket = ws;
    let alive = true;
    // A Pi that loses power sends no close, so only a missing pong shows the socket is dead.
    const ping = setInterval(() => {
      if (!alive) ws.terminate();
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_MS);

    ws.on("pong", () => { alive = true; });
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: ha.token }));
        if (message.type === "auth_invalid") console.error("[location] Home Assistant rejected the token");
        if (message.type === "auth_ok") {
          ws.send(JSON.stringify({ id: 1, type: "subscribe_trigger", trigger: { platform: "state", entity_id: entity } }));
          void fetchHaState<TrackerState>(entity, 10_000).then((tracker) => { if (tracker) ingestTracker(tracker); });
        }
        if (message.type === "result" && !message.success) console.error("[location] Home Assistant refused the subscription:", message.error?.message);
        if (message.type === "event") {
          const tracker = message.event?.variables?.trigger?.to_state;
          if (tracker) ingestTracker(tracker);
        }
      } catch (err) {
        console.error("[location] Bad message from Home Assistant:", err instanceof Error ? err.message : err);
      }
    });
    ws.on("error", (err) => console.error("[location] Home Assistant socket:", err.message));
    ws.on("close", () => {
      clearInterval(ping);
      if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.terminate();
  };
}
