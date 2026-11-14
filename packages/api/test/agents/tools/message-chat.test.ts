import { expect, test } from "vitest";
import { db } from "../../../src/db/index.js";
import { conversations } from "../../../src/db/schema.js";
import { execMessageChat, underCap } from "../../../src/agents/tools/message-chat.js";
import { registerSessionConversation } from "../../../src/mcp/state.js";

const SENDER = "5e5e5e5e-3333-4333-8333-333333333333";

function chat(id: string) {
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title: id.slice(0, 4), createdAt: now, updatedAt: now }).onConflictDoNothing().run();
}

test("takes five messages per chat in ten minutes, then refuses until the oldest ages out", () => {
  const start = 1_000_000;
  for (let i = 0; i < 5; i++) expect(underCap("cap-a", start + i)).toBe(true);
  expect(underCap("cap-a", start + 10)).toBe(false);
  expect(underCap("cap-b", start + 10)).toBe(true);
  expect(underCap("cap-a", start + 10 * 60_000 + 1)).toBe(true);
});

test("works only from a chat turn", () => {
  expect(execMessageChat({ conversationId: SENDER, message: "hi" })).toMatch(/^ERROR: message_chat works only/);
  expect(execMessageChat({ conversationId: SENDER, message: "hi" }, "no-such-session")).toMatch(/^ERROR: message_chat works only/);
});

test("refuses an empty message, an unknown chat and the sender's own chat", () => {
  chat(SENDER);
  registerSessionConversation("session-1", SENDER);
  expect(execMessageChat({ conversationId: SENDER, message: "  " }, "session-1")).toMatch(/^ERROR: message is empty/);
  expect(execMessageChat({ conversationId: "abcdef12", message: "hi" }, "session-1")).toMatch(/^ERROR: no chat with id abcdef12/);
  expect(execMessageChat({ conversationId: SENDER.slice(0, 8), message: "hi" }, "session-1")).toBe("ERROR: that is this chat.");
});
