import { expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { conversations } from "../../src/db/schema.js";
import { findChat, withChatReferences } from "../../src/chat/references.js";

function chat(id: string, title: string | null) {
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
}

test("spells out each chat the user mentioned, once", () => {
  chat("faad3875-1111-4111-8111-111111111111", "Slow chat switching");
  const text = withChatReferences("ask @session:faad3875 and again @session:faad3875");
  expect(text.startsWith("ask @session:faad3875 and again @session:faad3875\n\n[")).toBe(true);
  expect(text.match(/is the chat "Slow chat switching" \(conversation id faad3875-1111-4111-8111-111111111111\)/g)).toHaveLength(1);
});

test("leaves text without a known chat alone", () => {
  expect(withChatReferences("ask @session:0000aaaa or @chat about it")).toBe("ask @session:0000aaaa or @chat about it");
});

test("finds a chat by its full id or its first 8 characters", () => {
  chat("b1b57250-2222-4222-8222-222222222222", null);
  expect(findChat("b1b57250")?.id).toBe("b1b57250-2222-4222-8222-222222222222");
  expect(findChat("b1b57250-2222-4222-8222-222222222222")?.title).toBeNull();
});

test("refuses ids that are too short or carry LIKE wildcards", () => {
  expect(findChat("b1b5")).toBeUndefined();
  expect(findChat("%%%%%%%%")).toBeUndefined();
  expect(findChat("b1b5725_")).toBeUndefined();
});
