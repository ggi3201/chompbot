import { randomUUID } from "crypto";
import { expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";
import { markConversationSeen, unreadConversations } from "../../src/chat/unread.js";

function chat(): string {
  const id = randomUUID();
  const at = new Date().toISOString();
  db.insert(conversations).values({ id, title: "t", createdAt: at, updatedAt: at }).run();
  return id;
}

function message(conversationId: string, role: string, createdAt: string) {
  db.insert(chatMessages).values({ id: randomUUID(), conversationId, role, content: "x", createdAt }).run();
}

test("a reply after the last look is unread; the user's own message is not", () => {
  const [replied, ownMessage, neverSeen] = [chat(), chat(), chat()];
  markConversationSeen(replied);
  markConversationSeen(ownMessage);
  const later = new Date(Date.now() + 60_000).toISOString();
  message(replied, "assistant", later);
  message(ownMessage, "user", later);
  message(neverSeen, "assistant", new Date().toISOString());

  const unread = unreadConversations([replied, ownMessage, neverSeen]);
  expect(unread.has(replied)).toBe(true);
  expect(unread.has(ownMessage)).toBe(false);
  expect(unread.has(neverSeen)).toBe(true);
});

test("looking at a chat clears it for every device", () => {
  const id = chat();
  message(id, "assistant", new Date(Date.now() - 1000).toISOString());
  expect(unreadConversations([id]).has(id)).toBe(true);
  expect(markConversationSeen(id)).toBe(true);
  expect(unreadConversations([id]).has(id)).toBe(false);
  expect(markConversationSeen("missing")).toBe(false);
});
