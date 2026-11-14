import { randomUUID } from "crypto";
import { expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { chatItems, conversations } from "../../src/db/schema.js";
import { conversationsNeedingInput } from "../../src/chat/needs-input.js";
import { answerPendingQuestion, createPendingQuestion } from "../../src/mcp/pending-questions.js";
import { registerSessionConversation } from "../../src/mcp/state.js";

function chat(): string {
  const id = randomUUID();
  const at = new Date().toISOString();
  db.insert(conversations).values({ id, title: "t", createdAt: at, updatedAt: at }).run();
  return id;
}

function approval(conversationId: string, state: string) {
  const at = new Date().toISOString();
  db.insert(chatItems).values({
    id: randomUUID(), conversationId, turnId: "turn", seq: 1, kind: "approval",
    payload: JSON.stringify({ kind: "approval", requestId: "r", title: "Allow", detail: "", state }), createdAt: at, updatedAt: at,
  }).run();
}

test("a running chat with a pending approval needs input; a decided or stale one does not", () => {
  const [waiting, decided, crashed] = [chat(), chat(), chat()];
  approval(waiting, "pending");
  approval(decided, "accept");
  approval(crashed, "pending");
  const needs = conversationsNeedingInput(new Set([waiting, decided]));
  expect(needs.has(waiting)).toBe(true);
  expect(needs.has(decided)).toBe(false);
  expect(needs.has(crashed)).toBe(false);
});

test("a chat whose agent asked a question needs input until it is answered", () => {
  const id = chat();
  const session = randomUUID();
  registerSessionConversation(session, id);
  const answered = createPendingQuestion(session, "Which one?");
  expect(conversationsNeedingInput(new Set()).has(id)).toBe(true);
  answerPendingQuestion(session, "That one");
  expect(conversationsNeedingInput(new Set()).has(id)).toBe(false);
  return answered;
});
