import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ChompEvent } from "@chomp/shared";

const notifications = vi.hoisted(() => ({ notify: vi.fn(async () => "telegram" as const) }));
vi.mock("../../src/notifications/router.js", () => notifications);
const dispatch = vi.hoisted(() => ({ dispatchToAgent: vi.fn(async () => ({ response: "The garage is open." })) }));
vi.mock("../../src/agents/dispatch.js", () => dispatch);

import { db } from "../../src/db/index.js";
import { eventTriggers, locationHistory } from "../../src/db/schema.js";
import { off, on } from "../../src/events/bus.js";
import { startTriggerEvaluator } from "../../src/events/trigger-evaluator.js";
import { startHomeAssistantLocation } from "../../src/location/home-assistant.js";
import { ingestLocation, latestLocation, reportSchema } from "../../src/location/store.js";
import { execCreatePlaceTrigger, execGetLocation, execGetLocationHistory, execListPlaces } from "../../src/agents/tools/location.js";

const MINUTE = 60_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

function report(minutes: number, place?: string | null, source = "home-assistant") {
  return reportSchema.parse({ source, latitude: 58.97, longitude: 5.73, accuracyMeters: 10, place, capturedAt: minutesAgo(minutes) });
}

const events: ChompEvent[] = [];
const collect = (event: ChompEvent) => { if (event.type === "location.changed") events.push(event); };
const transitions = () => events.map((event) => event.type === "location.changed" && `${event.transition} ${event.place}`);

// A stand-in for Home Assistant: the REST states and the WebSocket API.
let tracker: Record<string, unknown>;
let haSockets: WebSocket[] = [];
let haMessages: Array<Record<string, unknown>> = [];
const zones = [
  { entity_id: "zone.home", attributes: { friendly_name: "Forest Home", latitude: 58.9, longitude: 5.7, radius: 100 } },
  { entity_id: "zone.store", attributes: { friendly_name: "Store", latitude: 58.8, longitude: 5.6, radius: 50 } },
  { entity_id: "light.kitchen", attributes: {} },
];
let ha: Server;

beforeAll(async () => {
  startTriggerEvaluator();
  const app = express();
  app.get("/api/states", (_req, res) => { res.json(zones); });
  app.get("/api/states/:id", (_req, res) => { res.json(tracker); });
  ha = createServer(app);
  const wss = new WebSocketServer({ server: ha, path: "/api/websocket" });
  wss.on("connection", (socket) => {
    haSockets.push(socket);
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      haMessages.push(message);
      if (message.type === "auth") socket.send(JSON.stringify({ type: message.access_token === "good" ? "auth_ok" : "auth_invalid" }));
    });
  });
  await new Promise<void>((resolve) => { ha.listen(0, "127.0.0.1", resolve); });
  process.env.HOMEASSISTANT_URL = `http://127.0.0.1:${(ha.address() as AddressInfo).port}/`;
  process.env.HOMEASSISTANT_TOKEN = "good";
});
afterAll(() => {
  delete process.env.HOMEASSISTANT_URL;
  delete process.env.HOMEASSISTANT_TOKEN;
  ha.close();
});

beforeEach(() => {
  vi.stubEnv("HOMEASSISTANT_LOCATION_ENTITY", "device_tracker.test_phone");
  db.delete(locationHistory).run();
  db.delete(eventTriggers).run();
  events.length = 0;
  haSockets = [];
  haMessages = [];
  notifications.notify.mockClear();
  dispatch.dispatchToAgent.mockClear();
  on(collect);
});
afterEach(() => { off(collect); vi.unstubAllEnvs(); });

test("the first report is a baseline, then a change of place says leave and arrive", () => {
  ingestLocation(report(30, "Home"));
  expect(events).toEqual([]);

  ingestLocation(report(20, "Home"));
  expect(events).toEqual([]);

  ingestLocation(report(10, null));
  ingestLocation(report(5, "Store"));
  expect(transitions()).toEqual(["leave Home", "arrive Store"]);

  ingestLocation(report(1, "Home"));
  expect(transitions()).toEqual(["leave Home", "arrive Store", "leave Store", "arrive Home"]);
  expect(events[0]).toMatchObject({ source: "home-assistant", latitude: 58.97, longitude: 5.73 });
});

test("a late or repeated report does not undo a newer one", () => {
  const repeated = report(5, "Store");
  ingestLocation(repeated);
  ingestLocation(repeated);
  ingestLocation(report(30, "Home"));

  expect(db.select().from(locationHistory).all()).toHaveLength(1);
  expect(latestLocation()?.place).toBe("Store");
  expect(events).toEqual([]);
});

test("a report outside the allowed range is refused", () => {
  expect(reportSchema.safeParse({ source: "phone", latitude: 200, longitude: 5, accuracyMeters: 10, capturedAt: minutesAgo(1) }).success).toBe(false);
});

test("a source that does not know places claims no place and fires nothing", () => {
  ingestLocation(report(10, "Home"));
  ingestLocation(report(5, undefined, "phone"));

  expect(latestLocation()).toMatchObject({ source: "phone", place: null });
  expect(events).toEqual([]);
});

test("history older than 90 days is removed", () => {
  ingestLocation(report(91 * 24 * 60, "Home"));
  ingestLocation(report(1, "Home"));
  expect(db.select().from(locationHistory).all()).toHaveLength(1);
});

test("get_location gives the age, saves a fresh fix, and falls back when the phone fails", () => {
  expect(execGetLocation()).toContain("ERROR: No location known yet");

  ingestLocation(report(30, "Home"));
  expect(JSON.parse(execGetLocation())).toMatchObject({ place: "Home", ageMinutes: 30 });

  const failed = JSON.parse(execGetLocation({ text: "Device not connected", failed: true }));
  expect(failed).toMatchObject({ ageMinutes: 30, freshError: "Device not connected" });

  const fix = { latitude: 58.1, longitude: 5.1, accuracyMeters: 65, altitudeMeters: 3, timestamp: minutesAgo(0) };
  const fresh = JSON.parse(execGetLocation({ text: JSON.stringify(fix), failed: false }));
  expect(fresh).toMatchObject({ source: "phone", latitude: 58.1, place: "Home", placeAsOf: expect.any(String), ageMinutes: 0 });
  expect(fresh.freshError).toBeUndefined();

  const unreadable = JSON.parse(execGetLocation({ text: "not json", failed: false }));
  expect(unreadable.freshError).toContain("could not read");

  expect(JSON.parse(execGetLocationHistory({ hours: 1 }))).toHaveLength(2);
  expect(JSON.parse(execGetLocationHistory({ hours: 1, limit: 1 }))).toHaveLength(1);
});

test("places are the zones in Home Assistant", async () => {
  const places = JSON.parse(await execListPlaces());
  expect(places).toEqual([
    { name: "Home", latitude: 58.9, longitude: 5.7, radiusMeters: 100 },
    { name: "Store", latitude: 58.8, longitude: 5.6, radiusMeters: 50 },
  ]);
});

test("a place trigger refuses a place that does not exist and an agent with no prompt", async () => {
  const unknown = await execCreatePlaceTrigger({ place: "Gym", on: "arrive", action_type: "notify" }, {});
  expect(unknown).toContain('No place named "Gym"');
  expect(unknown).toContain("Home, Store");

  const noPrompt = await execCreatePlaceTrigger({ place: "Store", on: "arrive", action_type: "run_agent" }, {});
  expect(noPrompt).toContain("agent_prompt required");
  expect(db.select().from(eventTriggers).all()).toEqual([]);
});

test("a one-shot notify trigger fires once, only on its place and direction, and is gone", async () => {
  const created = await execCreatePlaceTrigger({ place: "store", on: "arrive", action_type: "notify", notify_title: "Store", notify_body: "Buy milk" }, {});
  expect(created).toContain("fires once");

  ingestLocation(report(40, "Home"));
  ingestLocation(report(30, null));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(notifications.notify).not.toHaveBeenCalled();

  ingestLocation(report(20, "Store"));
  await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledOnce());
  expect(notifications.notify).toHaveBeenCalledWith({ type: "system", title: "Store", body: "Buy milk" });
  expect(db.select().from(eventTriggers).all()).toEqual([]);

  ingestLocation(report(10, null));
  ingestLocation(report(5, "Store"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(notifications.notify).toHaveBeenCalledOnce();
});

test("a place agent run sends its answer to the user, and two quick events run it once", async () => {
  await execCreatePlaceTrigger({ place: "Home", on: "leave", action_type: "run_agent", agent_prompt: "Is the garage open?" }, { provider: "claude", model: "sonnet" });

  ingestLocation(report(40, "Home"));
  ingestLocation(report(30, null));
  ingestLocation(report(29, "Home"));
  ingestLocation(report(28, null));

  await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledOnce());
  expect(dispatch.dispatchToAgent).toHaveBeenCalledOnce();
  const [routing, , options] = dispatch.dispatchToAgent.mock.calls[0] as unknown as [{ prompt: string }, unknown, Record<string, unknown>];
  expect(routing.prompt).toBe("Is the garage open?");
  expect(options).toMatchObject({ provider: "claude", model: "sonnet", deliveryChannel: "proactive" });
  expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Leave Home", body: "The garage is open.", broadcast: true }));
});

test("a repeating place trigger stays, and the user hears when its agent fails", async () => {
  await execCreatePlaceTrigger({ place: "Store", on: "arrive", action_type: "run_agent", agent_prompt: "Show the list", once: false }, {});
  const [row] = db.select().from(eventTriggers).all();
  expect(row).toMatchObject({ once: false, cooldownSeconds: 600 });

  dispatch.dispatchToAgent.mockRejectedValueOnce(new Error("no provider"));
  ingestLocation(report(20, null));
  ingestLocation(report(10, "Store"));

  await vi.waitFor(() => expect(notifications.notify).toHaveBeenCalledOnce());
  expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: "The agent failed: no provider" }));
  await vi.waitFor(() => expect(db.select().from(eventTriggers).all()[0].lastTriggeredAt).toBeTruthy());
});

test("following Home Assistant: signs in, catches up on connect, then takes each change", async () => {
  ingestLocation(report(60, "Home"));
  tracker = { state: "not_home", attributes: { latitude: 58.5, longitude: 5.5, gps_accuracy: 20 }, last_updated: minutesAgo(30) };

  const stop = startHomeAssistantLocation();
  try {
    await vi.waitFor(() => expect(transitions()).toEqual(["leave Home"]));
    expect(haMessages[0]).toEqual({ type: "auth", access_token: "good" });
    expect(haMessages[1]).toMatchObject({ type: "subscribe_trigger", trigger: { platform: "state", entity_id: "device_tracker.test_phone" } });
    expect(latestLocation()).toMatchObject({ latitude: 58.5, accuracyMeters: 20, place: null });

    const send = (state: string, minutes: number, attributes: Record<string, unknown> = { latitude: 58.8, longitude: 5.6, gps_accuracy: 5 }) =>
      haSockets[0].send(JSON.stringify({
        id: 1, type: "event",
        event: { variables: { trigger: { to_state: { state, attributes, last_updated: minutesAgo(minutes) } } } },
      }));

    send("Store", 20);
    await vi.waitFor(() => expect(transitions()).toEqual(["leave Home", "arrive Store"]));

    send("unavailable", 15);
    await vi.waitFor(() => expect(latestLocation()).toMatchObject({ place: "Store", capturedAt: expect.any(String) }));
    send("Store", 14, {});
    send("home", 10);
    await vi.waitFor(() => expect(transitions()).toEqual(["leave Home", "arrive Store", "leave Store", "arrive Home"]));
    expect(latestLocation()?.place).toBe("Home");
  } finally {
    stop();
  }
});

test("an unset location entity does not connect to Home Assistant", async () => {
  vi.stubEnv("HOMEASSISTANT_LOCATION_ENTITY", "");
  const stop = startHomeAssistantLocation();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(haSockets).toHaveLength(0);
    expect(haMessages).toHaveLength(0);
  } finally { stop(); }
});
