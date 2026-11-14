import { randomUUID } from "crypto";
import type { RunTarget } from "@chomp/shared";
import { db } from "../../db/index.js";
import { eventTriggers } from "../../db/schema.js";
import { listPlaces } from "../../location/home-assistant.js";
import { ingestLocation, latestLocation, latestZone, locationSince, reportSchema } from "../../location/store.js";

const HOUR_MS = 3_600_000;
/** A zone edge can flap, and a repeating trigger must not fire on each flap. */
const REPEAT_COOLDOWN_SECONDS = 600;

/** Saves what the phone's get_location tool returned. Returns why it could not, or null. */
function saveFreshFix(fix: { text: string; failed: boolean }): string | null {
  if (fix.failed) return fix.text;
  try {
    const { timestamp, ...position } = JSON.parse(fix.text);
    const report = reportSchema.safeParse({ ...position, source: "phone", capturedAt: timestamp });
    if (!report.success) return "The phone sent a position Chomp could not read.";
    ingestLocation(report.data);
    return null;
  } catch {
    return "The phone sent a position Chomp could not read.";
  }
}

export function execGetLocation(fix?: { text: string; failed: boolean }): string {
  const freshError = fix ? saveFreshFix(fix) : null;
  const latest = latestLocation();
  if (!latest) return `ERROR: No location known yet.${freshError ? ` The phone could not help: ${freshError}` : ""}`;
  const { id: _id, ...position } = latest;
  const zone = latestZone();
  return JSON.stringify({
    ...position,
    place: zone?.place ?? null,
    ...(zone && { placeAsOf: zone.capturedAt }),
    ageMinutes: Math.round((Date.now() - new Date(latest.capturedAt).getTime()) / 60_000),
    ...(freshError && { freshError }),
  }, null, 2);
}

export function execGetLocationHistory(args: { hours?: unknown; limit?: unknown }): string {
  const hours = typeof args.hours === "number" && args.hours > 0 ? args.hours : 24;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 100;
  const rows = locationSince(new Date(Date.now() - hours * HOUR_MS).toISOString(), limit);
  return JSON.stringify(rows.map(({ id: _id, ...row }) => row), null, 2);
}

export async function execListPlaces(): Promise<string> {
  try {
    return JSON.stringify(await listPlaces(), null, 2);
  } catch (err) {
    return `ERROR: Could not read places: ${err instanceof Error ? err.message : err}`;
  }
}

function placeAction(args: Record<string, unknown>, target: RunTarget, name: string): Record<string, unknown> | string {
  if (args.action_type === "notify") {
    return { type: "notify", title: typeof args.notify_title === "string" ? args.notify_title : name, body: typeof args.notify_body === "string" ? args.notify_body : "" };
  }
  if (args.action_type !== "run_agent") return "action_type must be notify or run_agent";
  if (typeof args.agent_prompt !== "string" || !args.agent_prompt) return "agent_prompt required for run_agent";
  return { type: "delegate", prompt: args.agent_prompt, deliver: true, ...target };
}

export async function execCreatePlaceTrigger(args: Record<string, unknown>, target: RunTarget): Promise<string> {
  if (args.on !== "arrive" && args.on !== "leave") return "ERROR: on must be arrive or leave";
  if (typeof args.place !== "string" || !args.place) return "ERROR: place required";

  // A misspelled place would wait forever without a sound, so it is checked here.
  let names: string[];
  try {
    names = (await listPlaces()).map((place) => place.name);
  } catch (err) {
    return `ERROR: Could not check the place: ${err instanceof Error ? err.message : err}`;
  }
  const wanted = args.place.toLowerCase();
  const place = names.find((name) => name.toLowerCase() === wanted);
  if (!place) return `ERROR: No place named "${args.place}". Places: ${names.join(", ")}. Ask the user to add it as a zone in Home Assistant.`;

  const name = typeof args.name === "string" && args.name ? args.name : `${args.on === "arrive" ? "Arrive at" : "Leave"} ${place}`;
  const action = placeAction(args, target, name);
  if (typeof action === "string") return `ERROR: ${action}`;

  const once = args.once !== false;
  const id = randomUUID();
  db.insert(eventTriggers).values({
    id,
    name,
    eventType: "location.changed",
    condition: JSON.stringify([
      { field: "place", op: "eq", value: place },
      { field: "transition", op: "eq", value: args.on },
    ]),
    action: JSON.stringify(action),
    once,
    cooldownSeconds: once ? 0 : REPEAT_COOLDOWN_SECONDS,
  }).run();
  return `Created trigger "${name}" (id: ${id}). It fires ${once ? "once" : "every time"} when the user ${args.on === "arrive" ? "arrives at" : "leaves"} ${place}.`;
}
