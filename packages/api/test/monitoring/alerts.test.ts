import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChompEvent } from "@chomp/shared";

const client = vi.hoisted(() => ({ alertsTarget: vi.fn() }));
vi.mock("../../src/monitoring/alerts-client.js", () => client);

import { db } from "../../src/db/index.js";
import { incidents, monitorWarnings } from "../../src/db/schema.js";
import { off, on } from "../../src/events/bus.js";
import { alertsIdle, FLOOD_LIMIT, notifyNewWarnings, renderIncident, replyUnderAlert } from "../../src/monitoring/alerts.js";
import { applyStatusChange, getIncident, settleIncidents } from "../../src/monitoring/incidents.js";
import { addTarget, clearMonitoring, MINUTE, NOW } from "./helpers.js";

const CHAT = 555;
let nextMessageId = 100;
const api = {
  sendMessage: vi.fn(async (_chat: number, _text: string, _opts?: Record<string, unknown>) => ({ message_id: nextMessageId++ })),
  editMessageText: vi.fn(async (_chat: number, _id: number, _text: string, _opts?: Record<string, unknown>) => true),
};

const at = (seconds: number) => NOW + seconds * 1000;
const change = (status: "up" | "down", key: string, now: number, error: string | null = "HTTP 502") =>
  applyStatusChange({ key }, { vantage: "home", status, error }, now);
/** The target goes down at `start` seconds and is held a cycle, so its incident opens at start + 60. */
const fail = (key: string, start = 0, error?: string) => { change("down", key, at(start), error); change("down", key, at(start + 60), error); };

const sent = () => api.sendMessage.mock.calls.map(([, text, opts]) => ({ text, opts }));
const edits = () => api.editMessageText.mock.calls.map(([, id, text, opts]) => ({ id, text, opts }));
const keyboardOf = (opts?: Record<string, unknown>) => (opts?.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard;

let busEvents: ChompEvent[] = [];
const record = (event: ChompEvent) => { busEvents.push(event); };

beforeEach(() => {
  clearMonitoring();
  nextMessageId = 100;
  busEvents = [];
  client.alertsTarget.mockReturnValue({ api, chatId: CHAT });
  api.sendMessage.mockClear();
  api.editMessageText.mockClear();
  on(record);
  return () => off(record);
});

describe("incident messages", () => {
  test("an incident gets one message with a Diagnose button, and the message id is kept", async () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    fail("web", 0, "HTTP 502");
    await alertsIdle();
    const [incident] = db.select().from(incidents).all();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toContain("<b>Web is down</b>\nHTTP 502");
    expect(sent()[0].opts).toMatchObject({ parse_mode: "HTML" });
    expect(keyboardOf(sent()[0].opts)).toEqual([[{ text: "Diagnose", callback_data: `diag:${incident.id}` }]]);
    expect(incident.telegramMessageId).toBe(100);
    expect(getIncident(incident.id)?.events.map((e) => e.kind)).toEqual(["opened", "alerted"]);
    fail("web", 120); // still down: nothing more
    await alertsIdle();
    expect(sent()).toHaveLength(1);
    expect(edits()).toHaveLength(0);
  });

  test("services that join edit the message and do not send a new one", async () => {
    addTarget({ key: "host:mini", title: "mini", kind: "host", status: "down" });
    for (const key of ["a", "b"]) addTarget({ key, title: key.toUpperCase(), status: "down", dependsOn: ["host:mini"] });
    fail("a", 0);
    fail("b", 10);
    await alertsIdle();
    expect(sent()).toHaveLength(1);
    expect(edits()).toHaveLength(1);
    expect(edits()[0]).toMatchObject({ id: 100 });
    expect(edits()[0].text).toContain("Cause: mini");
    expect(edits()[0].text).toContain("Down (2): A, B");
    expect(keyboardOf(edits()[0].opts)).toBeDefined();
  });

  test("recovery edits the message to say how long it lasted, and sends one silent reply", async () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    fail("web", 0);
    change("up", "web", at(60 + 14 * 60));
    await alertsIdle();
    expect(edits().at(-1)?.text).toBe("<b>Web is down</b>\nRecovered after 14 min");
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({ text: "Recovered after 14 min" });
    expect(sent()[1].opts).toMatchObject({ disable_notification: true, reply_parameters: { message_id: 100 } });
  });

  test("a service that goes down again after recovery edits the message back and replies with a ping", async () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    fail("web", 0);
    change("up", "web", at(300));
    fail("web", 360);
    await alertsIdle();
    expect(edits().at(-1)?.text).toContain("Since");
    expect(sent().at(-1)?.text).toBe("<b>Web is down</b>\nDown again");
    expect(sent().at(-1)?.opts?.disable_notification).toBeUndefined();
  });

  test("names, errors and causes are escaped for HTML", async () => {
    addTarget({ key: "web", title: "<b>Web</b> & co", status: "down" });
    fail("web", 0, "bad <html> & more");
    await alertsIdle();
    expect(sent()[0].text).toBe("<b>&lt;b&gt;Web&lt;/b&gt; &amp; co is down</b>\nbad &lt;html&gt; &amp; more\nSince 13:01");
  });

  test("a flapping incident says so once, stays silent, and speaks again when it is stable", async () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    fail("web", 0);
    await alertsIdle();
    change("up", "web", at(300));
    await alertsIdle();
    fail("web", 360);
    await alertsIdle();
    change("up", "web", at(600)); // the 4th change
    await alertsIdle();
    const afterFlap = { sent: sent().length, edits: edits().length };
    expect(edits().at(-1)?.text).toContain("It keeps going up and down");

    fail("web", 660);
    change("up", "web", at(900));
    await alertsIdle();
    expect({ sent: sent().length, edits: edits().length }).toEqual(afterFlap);

    settleIncidents(at(900 + 15 * 60));
    await alertsIdle();
    expect(edits().at(-1)?.text).toContain("Recovered after");
    expect(sent().at(-1)?.opts).toMatchObject({ disable_notification: true });
  });

  test("more than 5 incidents in 2 minutes become one summary, edited as the count grows", async () => {
    for (let i = 1; i <= 7; i++) addTarget({ key: `svc${i}`, status: "down" });
    for (let i = 1; i <= 7; i++) fail(`svc${i}`, 0);
    await alertsIdle();
    expect(FLOOD_LIMIT).toBe(5);
    expect(sent().map((m) => m.text).filter((text) => text.includes("is down"))).toHaveLength(5);
    expect(sent().map((m) => m.text)).toContain("6 incidents opened, see Chomp");
    expect(edits()).toEqual([expect.objectContaining({ text: "7 incidents opened, see Chomp" })]);
    expect(db.select().from(incidents).all().filter((i) => i.telegramMessageId === null)).toHaveLength(2);

    change("up", "svc7", at(300)); // a covered incident has no message to edit and sends nothing
    await alertsIdle();
    expect(edits()).toHaveLength(1);
  });

  test("with the alerts bot not set up, incidents still open and nothing is sent", async () => {
    client.alertsTarget.mockReturnValue(null);
    addTarget({ key: "web", status: "down" });
    fail("web", 0);
    await alertsIdle();
    expect(db.select().from(incidents).all()).toHaveLength(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  test("a Telegram failure does not stop the incident", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("Telegram is down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    addTarget({ key: "web", status: "down" });
    fail("web", 0);
    await alertsIdle();
    expect(db.select().from(incidents).get()).toMatchObject({ state: "open", telegramMessageId: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("failed"), "Telegram is down");
    log.mockRestore();
  });

  test("an edit that changes nothing is not an error", async () => {
    api.editMessageText.mockRejectedValueOnce(new Error("Bad Request: message is not modified"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    addTarget({ key: "host:mini", title: "mini", kind: "host", status: "down" });
    for (const key of ["a", "b"]) addTarget({ key, status: "down", dependsOn: ["host:mini"] });
    fail("a", 0);
    fail("b", 10);
    await alertsIdle();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  test("renderIncident names the cause and the first error of a one-service incident only once", () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    fail("web", 0, "HTTP 502");
    const text = renderIncident(getIncident(db.select().from(incidents).get()!.id)!);
    expect(text).not.toContain("Cause:");
    expect(text).not.toContain("Down (");
  });
});

describe("replies under the alert", () => {
  test("replyUnderAlert replies to the alert message as HTML, and falls back to plain text", async () => {
    addTarget({ key: "web", status: "down" });
    fail("web", 0);
    await alertsIdle();
    const id = db.select().from(incidents).get()!.id;
    api.sendMessage.mockClear();

    expect(await replyUnderAlert(id, "The **disk** is full")).toBe(true);
    expect(sent()[0]).toMatchObject({ text: "The <b>disk</b> is full" });
    expect(sent()[0].opts).toMatchObject({ parse_mode: "HTML", reply_parameters: { message_id: 100 } });

    api.sendMessage.mockRejectedValueOnce(new Error("can't parse entities"));
    api.sendMessage.mockClear();
    expect(await replyUnderAlert(id, "plain <text")).toBe(true);
    expect(sent().at(-1)).toMatchObject({ text: "plain <text" });
    expect(sent().at(-1)?.opts).not.toHaveProperty("parse_mode");
  });

  test("with no alert message there is nothing to reply to", async () => {
    client.alertsTarget.mockReturnValue(null);
    addTarget({ key: "web", status: "down" });
    fail("web", 0);
    await alertsIdle();
    expect(await replyUnderAlert(db.select().from(incidents).get()!.id, "text")).toBe(false);
  });
});

describe("warnings", () => {
  const warn = (key: string, over: Partial<typeof monitorWarnings.$inferInsert> = {}) =>
    db.insert(monitorWarnings).values({ key, kind: "database-open-lan", text: `Warning ${key}`, firstSeen: "2026-11-08T10:00:00.000Z", lastSeen: "2026-11-08T10:00:00.000Z", ...over }).run();

  test("each new warning sends one silent message, once", async () => {
    warn("w1", { text: "Redis is open to the <LAN>", targetKey: "mini:6379" });
    warn("w2");
    warn("old", { resolvedAt: "2026-11-08T11:00:00.000Z" });
    warn("muted", { muted: true });
    expect(await notifyNewWarnings(NOW)).toBe(2);
    expect(sent().map((m) => m.text)).toEqual(["<b>Warning</b>\nRedis is open to the &lt;LAN&gt;", "<b>Warning</b>\nWarning w2"]);
    expect(sent().every((m) => m.opts?.disable_notification === true)).toBe(true);
    expect(db.select().from(monitorWarnings).all().filter((w) => w.notifiedAt).map((w) => w.key).sort()).toEqual(["w1", "w2"]);
    expect(busEvents).toEqual([
      { type: "monitoring.warning.new", key: "w1", kind: "database-open-lan", targetKey: "mini:6379", text: "Redis is open to the <LAN>" },
      expect.objectContaining({ key: "w2" }),
    ]);

    expect(await notifyNewWarnings(NOW + MINUTE)).toBe(0);
    expect(sent()).toHaveLength(2);
  });

  test("a burst of warnings is one message", async () => {
    for (let i = 1; i <= 8; i++) warn(`w${i}`);
    await notifyNewWarnings(NOW);
    expect(sent().map((m) => m.text)).toEqual(["8 new warnings, see Chomp"]);
  });

  test("with the alerts bot not set up, warnings are marked, so setting it up later does not replay them", async () => {
    client.alertsTarget.mockReturnValue(null);
    warn("w1");
    expect(await notifyNewWarnings(NOW)).toBe(1);
    client.alertsTarget.mockReturnValue({ api, chatId: CHAT });
    expect(await notifyNewWarnings(NOW + MINUTE)).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
