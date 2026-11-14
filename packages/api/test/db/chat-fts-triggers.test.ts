import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";

const NOW = "2026-11-04T07:00:00.000Z";

function searchHits(word: string): string[] {
  return db.all<{ message_id: string }>(sql`SELECT message_id FROM chat_messages_fts WHERE chat_messages_fts MATCH ${word}`).map((row) => row.message_id);
}

function insertChat(content: string): { conversationId: string; messageId: string } {
  const conversationId = randomUUID();
  const messageId = randomUUID();
  db.insert(conversations).values({ id: conversationId, title: "fts test", createdAt: NOW, updatedAt: NOW }).run();
  db.insert(chatMessages).values({ id: messageId, conversationId, role: "user", content, createdAt: NOW }).run();
  return { conversationId, messageId };
}

test("deleting a chat with messages also removes them from search", () => {
  const { conversationId, messageId } = insertChat("zebraquartz");
  expect(searchHits("zebraquartz")).toEqual([messageId]);

  db.delete(chatMessages).where(eq(chatMessages.conversationId, conversationId)).run();
  db.delete(conversations).where(eq(conversations.id, conversationId)).run();

  expect(searchHits("zebraquartz")).toEqual([]);
});

test("editing a message re-indexes it", () => {
  const { conversationId, messageId } = insertChat("walrusquill");

  db.update(chatMessages).set({ content: "ottermint" }).where(eq(chatMessages.id, messageId)).run();

  expect(searchHits("walrusquill")).toEqual([]);
  expect(searchHits("ottermint")).toEqual([messageId]);

  db.delete(chatMessages).where(eq(chatMessages.conversationId, conversationId)).run();
  db.delete(conversations).where(eq(conversations.id, conversationId)).run();
});
