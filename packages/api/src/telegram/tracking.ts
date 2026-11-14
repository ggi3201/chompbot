// Telegram message-to-conversation links, so a swipe-reply lands in the chat the
// message came from. In the DB because every deploy restarts prod.
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages, conversations, telegramMessageLinks } from "../db/schema.js";

/** Track a sent Telegram message for conversation threading */
export function trackSentMessage(telegramMsgId: number, conversationId: string): void {
  db.insert(telegramMessageLinks)
    .values({ telegramMsgId, conversationId })
    .onConflictDoUpdate({ target: telegramMessageLinks.telegramMsgId, set: { conversationId } })
    .run();
}

/** Look up which conversation a Telegram message belongs to */
export function getConversationForTelegramMsg(telegramMsgId: number): string | undefined {
  return db.select().from(telegramMessageLinks).where(eq(telegramMessageLinks.telegramMsgId, telegramMsgId)).get()?.conversationId;
}

/** Get the last Telegram message_id sent for a conversation (for reply threading) */
export function getLastTelegramMsgForConv(conversationId: string): number | undefined {
  return db.select().from(telegramMessageLinks)
    .where(eq(telegramMessageLinks.conversationId, conversationId))
    .orderBy(desc(telegramMessageLinks.telegramMsgId))
    .limit(1)
    .get()?.telegramMsgId;
}

export function shortChatTitle(title: string | null | undefined): string {
  const t = title?.trim() || "Untitled";
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/** One-line HTML header naming the chat a bot message belongs to. */
export function chatLabelHtml(conversationId: string): string {
  const conv = db.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, conversationId)).get();
  const userMessages = db.select({ id: chatMessages.id }).from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "user")))
    .limit(2)
    .all().length;
  const title = shortChatTitle(conv?.title).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<i>${userMessages <= 1 ? "🆕" : "💬"} ${title}</i>`;
}
