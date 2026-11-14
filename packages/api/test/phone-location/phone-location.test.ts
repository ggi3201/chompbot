import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { locationHistory } from "../../src/db/schema.js";
import { execGetLocation } from "../../src/agents/tools/location.js";
import { off, on } from "../../src/events/bus.js";
import type { ChompEvent } from "@chomp/shared";
import { ingestLocation, reportSchema } from "../../src/location/store.js";
import routes from "../../src/routes/phone-location.js";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const report = (fields: Record<string, unknown> = {}) => ({
  latitude: 59.91,
  longitude: 10.75,
  accuracyMeters: 65,
  capturedAt: minutesAgo(5),
  ...fields,
});
const fromHomeAssistant = (minutes: number, place: string | null) => reportSchema.parse({
  source: "home-assistant", latitude: 58.97, longitude: 5.73, accuracyMeters: 10, place, capturedAt: minutesAgo(minutes),
});

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

const post = (body: unknown) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/location", routes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/location`;
});
afterAll(() => server.close());
beforeEach(() => {
  db.delete(locationHistory).run();
});

test("a report reaches the tool with its age and address", async () => {
  expect((await post(report({ address: "Storgata 1, Oslo" }))).status).toBe(204);

  expect(JSON.parse(execGetLocation())).toMatchObject({
    source: "phone",
    latitude: 59.91,
    longitude: 10.75,
    accuracyMeters: 65,
    address: "Storgata 1, Oslo",
    ageMinutes: 5,
  });
});

test("a late report does not undo a newer one, and every report is kept", async () => {
  await post(report({ latitude: 60.39, capturedAt: minutesAgo(5) }));
  await post(report({ latitude: 59.91, capturedAt: minutesAgo(30) }));
  expect(JSON.parse(execGetLocation()).latitude).toBe(60.39);

  await post(report({ latitude: 58.97, capturedAt: minutesAgo(1) }));
  expect(JSON.parse(execGetLocation()).latitude).toBe(58.97);
  expect(db.select().from(locationHistory).all()).toHaveLength(2);
});

test("the tool has no zone until Home Assistant reports; the phone cannot claim one, and the tool says how old the zone is", async () => {
  await post(report({ capturedAt: minutesAgo(10) }));
  const before = JSON.parse(execGetLocation());
  expect(before.place).toBeNull();
  expect(before.placeAsOf).toBeUndefined();

  const stale = fromHomeAssistant(45 * 60, "Home");
  ingestLocation(stale);
  await post(report({ place: "Store", address: "Oslo S, Oslo" }));

  expect(JSON.parse(execGetLocation())).toMatchObject({ source: "phone", place: "Home", placeAsOf: stale.capturedAt, address: "Oslo S, Oslo", ageMinutes: 5 });
  expect(db.select().from(locationHistory).all().filter((row) => row.source === "phone")[0].place).toBeNull();
});

test("phone reports do not move the user out of a zone, and do not hide a zone change that comes just after", async () => {
  const seen: string[] = [];
  const listen = (event: ChompEvent) => { if (event.type === "location.changed") seen.push(`${event.transition} ${event.place}`); };
  on(listen);
  try {
    ingestLocation(fromHomeAssistant(60, "Home"));
    await post(report({ capturedAt: minutesAgo(5) }));
    expect(seen).toEqual([]);

    // Home Assistant's change happened before the phone's report, but arrives after it.
    ingestLocation(fromHomeAssistant(6, null));
    expect(seen).toEqual(["leave Home"]);
  } finally {
    off(listen);
  }
});

test("invalid reports are refused", async () => {
  for (const bad of [report({ latitude: 91 }), report({ longitude: -181 }), report({ capturedAt: "yesterday" }), {}]) {
    expect((await post(bad)).status).toBe(400);
  }
  expect(db.select().from(locationHistory).all()).toHaveLength(0);
});
