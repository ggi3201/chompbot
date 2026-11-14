import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const apns = vi.hoisted(() => ({
  sendAlertPush: vi.fn(async () => ({ ok: true })),
  sendSilentPush: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../src/lib/apns.js", () => apns);

import { db } from "../../src/db/index.js";
import { devicePushTokens, phoneCards } from "../../src/db/schema.js";
import { execListPhoneCards, execPublishPhoneCards, execRemovePhoneCards } from "../../src/agents/tools/phone-cards.js";
import routes from "../../src/routes/phone-cards.js";

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

function trip(leaveAt: string) {
  return {
    group: "trip",
    board: "travel",
    cards: [
      { showFrom: inHours(1), showUntil: inHours(3), headline: `Leave at ${leaveAt}`, countdownTo: leaveAt },
      { showFrom: inHours(3), showUntil: inHours(4), headline: "Leave now" },
    ],
  };
}

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use("/cards", routes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cards`;
});
afterAll(() => server.close());

beforeEach(() => {
  db.delete(phoneCards).run();
  db.delete(devicePushTokens).run();
  db.insert(devicePushTokens).values({ deviceId: "phone", apnsToken: "token" }).run();
});

test("publishing stores the cards with UTC times and tells the phone silently", async () => {
  const result = await execPublishPhoneCards({
    group: "trip",
    cards: [{
      showFrom: "2099-11-10T08:00:00+01:00",
      showUntil: "2099-11-10T12:30:00+01:00",
      headline: "Flight today",
      alerts: [{ at: "2099-11-10T12:15:00+01:00", text: "Leave in 15 minutes" }],
    }],
  });

  expect(result).toContain('Published 1 card(s) to group "trip" on board "today"');
  expect(apns.sendSilentPush).toHaveBeenCalledOnce();
  expect(apns.sendAlertPush).not.toHaveBeenCalled();
  const { cards } = await (await fetch(url)).json() as { cards: unknown[] };
  expect(cards).toMatchObject([{
    group: "trip",
    board: "today",
    showFrom: "2099-11-10T07:00:00.000Z",
    alerts: [{ at: "2099-11-10T11:15:00.000Z", text: "Leave in 15 minutes" }],
  }]);
});

test("a card keeps its icon, tone, rows and link", async () => {
  await execPublishPhoneCards({
    group: "flight",
    cards: [{
      showFrom: inHours(1),
      showUntil: inHours(2),
      headline: "Boarding",
      icon: "airplane",
      tone: "urgent",
      rows: [{ label: "Gate", value: "B12" }],
      link: "https://example.com/pass",
    }],
  });

  expect(JSON.parse(execListPhoneCards())).toMatchObject([{
    icon: "airplane",
    tone: "urgent",
    rows: [{ label: "Gate", value: "B12" }],
    link: "https://example.com/pass",
  }]);
});

test("a card without the optional fields gets the normal tone and no rows", async () => {
  await execPublishPhoneCards(trip(inHours(3)));

  expect(JSON.parse(execListPhoneCards())[0]).toMatchObject({ tone: "normal", rows: [], icon: null, link: null });
});

test("text too long for a small widget is refused", async () => {
  const card = { showFrom: inHours(1), showUntil: inHours(2), headline: "x".repeat(49) };

  expect(await execPublishPhoneCards({ group: "g", cards: [card] })).toContain("cards.0.headline");
  expect(await execPublishPhoneCards({
    group: "g",
    cards: [{ ...card, headline: "Short", rows: [{ label: "Label", value: "v".repeat(23) }] }],
  })).toContain("cards.0.rows.0.value");
  expect(db.select().from(phoneCards).all()).toHaveLength(0);
});

test("publishing a group again replaces its cards and leaves other groups alone", async () => {
  await execPublishPhoneCards(trip(inHours(3)));
  await execPublishPhoneCards({ ...trip(inHours(3)), group: "other" });
  await execPublishPhoneCards({ group: "trip", cards: [{ showFrom: inHours(1), showUntil: inHours(2), headline: "Only card" }] });

  const cards = JSON.parse(execListPhoneCards()) as { group: string; headline: string }[];
  expect(cards.filter((card) => card.group === "trip").map((card) => card.headline)).toEqual(["Only card"]);
  expect(cards.filter((card) => card.group === "other")).toHaveLength(2);
});

test("a moved countdown sends one visible notification with the next headline", async () => {
  const first = inHours(3);
  const second = inHours(3.5);
  await execPublishPhoneCards(trip(first));
  vi.clearAllMocks();

  const result = await execPublishPhoneCards(trip(second));

  expect(result).toContain("visible notification");
  expect(apns.sendAlertPush).toHaveBeenCalledWith(expect.objectContaining({ title: "Time changed", body: `Leave at ${second}` }));
  expect(apns.sendSilentPush).not.toHaveBeenCalled();
});

test("rewording a card and publishing a new group do not alert", async () => {
  const leaveAt = inHours(3);
  await execPublishPhoneCards(trip(leaveAt));
  const reworded = trip(leaveAt);
  reworded.cards[1].headline = "Go now";
  await execPublishPhoneCards(reworded);

  expect(apns.sendAlertPush).not.toHaveBeenCalled();
});

test("cards that have ended leave the list and are cleared by the next publish", async () => {
  db.insert(phoneCards).values({
    id: "old",
    groupKey: "old-trip",
    board: "travel",
    showFrom: inHours(-3),
    showUntil: inHours(-1),
    headline: "Gone",
    alerts: [],
    tone: "normal",
    rows: [],
  }).run();
  expect(execListPhoneCards()).not.toContain("Gone");

  await execPublishPhoneCards(trip(inHours(3)));

  expect(db.select().from(phoneCards).all().map((card) => card.groupKey)).not.toContain("old-trip");
});

test("invalid cards are refused", async () => {
  const base = { showFrom: inHours(2), showUntil: inHours(1), headline: "Backwards" };
  expect(await execPublishPhoneCards({ group: "g", cards: [base] })).toContain("showUntil must be after showFrom");
  expect(await execPublishPhoneCards({ group: "g", cards: [{ ...base, showFrom: "12:50", showUntil: inHours(1) }] })).toContain("ERROR: Invalid cards");
  expect(await execPublishPhoneCards({ group: "g", cards: [{ showFrom: inHours(-2), showUntil: inHours(-1), headline: "Late" }] })).toContain("every card has already ended");
  expect(db.select().from(phoneCards).all()).toHaveLength(0);
});

test("a phone that cannot be reached is reported, and the cards stay saved", async () => {
  apns.sendSilentPush.mockResolvedValueOnce({ ok: false, error: "APNs not configured" } as never);

  const result = await execPublishPhoneCards(trip(inHours(3)));

  expect(result).toContain("ERROR: Cards saved, but the phone was not reached: APNs not configured");
  expect(db.select().from(phoneCards).all()).toHaveLength(2);
});

test("a phone registered under several device ids gets one push", async () => {
  db.insert(devicePushTokens).values({ deviceId: "same-phone-old-id", apnsToken: "token" }).run();

  await execPublishPhoneCards(trip(inHours(3)));

  expect(apns.sendSilentPush).toHaveBeenCalledOnce();
});

test("removing a group deletes it and tells the phone", async () => {
  await execPublishPhoneCards(trip(inHours(3)));
  vi.clearAllMocks();

  expect(await execRemovePhoneCards({ group: "trip" })).toBe('Removed 2 card(s) from group "trip".');
  expect(apns.sendSilentPush).toHaveBeenCalledOnce();
  expect(await execRemovePhoneCards({ group: "trip" })).toContain("ERROR: No cards");
});
