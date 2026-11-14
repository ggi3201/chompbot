import { beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversations, settings, telegramMessageLinks } from "../../src/db/schema.js";
import { placeholderTitle } from "../../src/chat/handler.js";
import { handleNewConversation, resolveTelegramConversation, targetTelegramConversation } from "../../src/telegram/handlers.js";
import { chatLabelHtml, getConversationForTelegramMsg, getLastTelegramMsgForConv, trackSentMessage } from "../../src/telegram/tracking.js";
import type { Context } from "grammy";

const HOUR = 60 * 60 * 1000;
const bot = { is_bot: true };
const human = { is_bot: false };

function chat(id: string, ageMs = 0, title = id): string {
  const at = new Date(Date.now() - ageMs).toISOString();
  db.insert(conversations).values({ id, title, createdAt: at, updatedAt: at }).run();
  return id;
}

/** Make `id` the current Telegram chat, the way a run does. */
async function makeCurrent(id: string) {
  await handleNewConversation({ reply: async () => ({}) } as unknown as Context);
  db.insert(settings).values({ key: "telegram_conversation_id", value: id })
    .onConflictDoUpdate({ target: settings.key, set: { value: id } }).run();
  // handleNewConversation cleared the in-memory pointer, so the setting is reread.
}

beforeEach(async () => {
  db.delete(telegramMessageLinks).run();
  await handleNewConversation({ reply: async () => ({}) } as unknown as Context);
});

test("a plain message continues the current chat while it is active", async () => {
  await makeCurrent(chat(`active-${Date.now()}`, HOUR));
  const current = targetTelegramConversation();
  expect(resolveTelegramConversation()).toBe(current);
});

test("a plain message to a stale chat starts a new one and moves current there", async () => {
  const stale = chat(`stale-${Date.now()}`, 7 * HOUR);
  await makeCurrent(stale);
  const resolved = resolveTelegramConversation();
  expect(resolved).not.toBe(stale);
  expect(targetTelegramConversation()).toBe(resolved);
});

test("a swipe-reply goes to the message's chat, however old", async () => {
  const old = chat(`old-${Date.now()}`, 30 * 24 * HOUR);
  trackSentMessage(101, old);
  expect(resolveTelegramConversation({ message_id: 101, from: bot })).toBe(old);
});

test("a swipe-reply to a bot message with no chat gets its own, not the current one", async () => {
  const current = chat(`cur-${Date.now()}`);
  await makeCurrent(current);
  const resolved = resolveTelegramConversation({ message_id: 999, from: bot });
  expect(resolved).not.toBe(current);
  expect(db.select().from(conversations).where(eq(conversations.id, resolved)).get()).toBeTruthy();
});

test("a link to a deleted chat also gets a new chat", async () => {
  trackSentMessage(102, "deleted-chat");
  expect(targetTelegramConversation({ message_id: 102, from: bot })).toBeUndefined();
  expect(resolveTelegramConversation({ message_id: 102, from: bot })).not.toBe("deleted-chat");
});

test("swiping your own message is just a plain message", async () => {
  const current = chat(`own-${Date.now()}`);
  await makeCurrent(current);
  expect(resolveTelegramConversation({ message_id: 5, from: human })).toBe(current);
});

test("a swipe into another chat is not aimed at a question waiting in the current one", async () => {
  const waiting = chat(`waiting-${Date.now()}`);
  const other = chat(`other-${Date.now()}`);
  await makeCurrent(waiting);
  trackSentMessage(103, other);
  expect(targetTelegramConversation()).toBe(waiting);
  expect(targetTelegramConversation({ message_id: 103, from: bot })).toBe(other);
});

test("links live in the DB, and a resend relinks", () => {
  trackSentMessage(201, "a");
  trackSentMessage(202, "a");
  trackSentMessage(202, "b");
  expect(getConversationForTelegramMsg(201)).toBe("a");
  expect(getConversationForTelegramMsg(202)).toBe("b");
  expect(getLastTelegramMsgForConv("a")).toBe(201);
});

test("the label names the chat, escapes its title and marks a new chat", () => {
  const id = chat(`label-${Date.now()}`, 0, "Fix <b> & stuff");
  expect(chatLabelHtml(id)).toBe("<i>🆕 Fix &lt;b&gt; &amp; stuff</i>");
  expect(chatLabelHtml(chat(`long-${Date.now()}`, 0, "x".repeat(80)))).toContain(`${"x".repeat(47)}…`);
});

test("a swipe-reply's chat is titled after what you said, not the quote", () => {
  expect(placeholderTitle('[Replying to: "Stock alert: "ACME" up 5%"]\n\nsell half?')).toBe("sell half?");
});
