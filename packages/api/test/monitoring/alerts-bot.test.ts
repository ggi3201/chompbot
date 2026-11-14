import type { Context } from "grammy";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const diagnose = vi.hoisted(() => ({ startDiagnosis: vi.fn() }));
vi.mock("../../src/monitoring/diagnose.js", () => diagnose);

import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { alertsConfig, alertsTarget } from "../../src/monitoring/alerts-client.js";
import { handleDiagnoseButton, syncAlertsBot } from "../../src/monitoring/alerts-bot.js";

const OWNER = 4242;
const KEYS = ["secret:TELEGRAM_ALERTS_BOT_TOKEN", "telegram_alerts_chat_id", "telegram_alerts_owner_id"];
const put = (key: string, value: string) => db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
const configure = (over: { owner?: string; chat?: string } = {}) => {
  put("secret:TELEGRAM_ALERTS_BOT_TOKEN", "123456:test-token");
  put("telegram_alerts_chat_id", over.chat ?? "-1001");
  put("telegram_alerts_owner_id", over.owner ?? String(OWNER));
};

const tap = (from: number | undefined, data = "diag:inc-1") => {
  const answerCallbackQuery = vi.fn(async () => true);
  return { ctx: { from: from === undefined ? undefined : { id: from }, callbackQuery: { data }, answerCallbackQuery } as unknown as Context, answerCallbackQuery };
};

beforeEach(() => {
  db.delete(settings).where(inArray(settings.key, KEYS)).run();
  diagnose.startDiagnosis.mockReset();
});
afterEach(() => db.delete(settings).where(inArray(settings.key, KEYS)).run());

test("the owner's tap starts a diagnosis of that incident and is answered", async () => {
  configure();
  diagnose.startDiagnosis.mockReturnValue({ started: true, done: Promise.resolve() });
  const { ctx, answerCallbackQuery } = tap(OWNER);
  await handleDiagnoseButton(ctx);
  expect(diagnose.startDiagnosis).toHaveBeenCalledWith("inc-1");
  expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "Diagnosing. The answer comes as a reply." });
});

test("a diagnosis that is already running, or an incident that is gone, is answered with the reason", async () => {
  configure();
  diagnose.startDiagnosis.mockReturnValueOnce({ started: false, reason: "running" }).mockReturnValueOnce({ started: false, reason: "not-found" });
  const running = tap(OWNER);
  await handleDiagnoseButton(running.ctx);
  expect(running.answerCallbackQuery).toHaveBeenCalledWith({ text: "A diagnosis is already running." });
  const gone = tap(OWNER);
  await handleDiagnoseButton(gone.ctx);
  expect(gone.answerCallbackQuery).toHaveBeenCalledWith({ text: "That incident is gone." });
});

test("anyone but the owner gets no answer and starts nothing, and with no owner set nobody is answered", async () => {
  configure();
  for (const from of [OWNER + 1, undefined]) {
    const { ctx, answerCallbackQuery } = tap(from);
    await handleDiagnoseButton(ctx);
    expect(answerCallbackQuery).not.toHaveBeenCalled();
  }
  configure({ owner: "" });
  const { ctx, answerCallbackQuery } = tap(OWNER);
  await handleDiagnoseButton(ctx);
  expect(answerCallbackQuery).not.toHaveBeenCalled();
  expect(diagnose.startDiagnosis).not.toHaveBeenCalled();
});

test("the config reads the token as a secret and the chat and owner as settings", () => {
  expect(alertsConfig()).toBeNull();
  expect(alertsTarget()).toBeNull();
  configure();
  expect(alertsConfig()).toEqual({ token: "123456:test-token", chatId: -1001, ownerId: OWNER });
  expect(alertsTarget()).toMatchObject({ chatId: -1001 });
  configure({ chat: "not a number" });
  expect(alertsTarget()).toBeNull();
});

test("syncAlertsBot does not poll until the token and the owner are both set", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  syncAlertsBot(); // nothing configured: nothing starts, nothing throws
  put("secret:TELEGRAM_ALERTS_BOT_TOKEN", "123456:test-token");
  syncAlertsBot(); // a token without an owner is not enough
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});
