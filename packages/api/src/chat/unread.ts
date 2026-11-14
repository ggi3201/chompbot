import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages, conversations } from "../db/schema.js";

/** Chats with a reply newer than the last time the user had them on screen. A chat never seen counts every reply. */
export function unreadConversations(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .selectDistinct({ id: chatMessages.conversationId })
    .from(chatMessages)
    .innerJoin(conversations, eq(conversations.id, chatMessages.conversationId))
    .where(and(
      inArray(chatMessages.conversationId, ids),
      eq(chatMessages.role, "assistant"),
      gt(chatMessages.createdAt, sql`coalesce(${conversations.lastSeenAt}, '')`),
    ))
    .all();
  return new Set(rows.map((r) => r.id));
}

export function markConversationSeen(id: string): boolean {
  return db.update(conversations).set({ lastSeenAt: new Date().toISOString() }).where(eq(conversations.id, id)).run().changes > 0;
}
