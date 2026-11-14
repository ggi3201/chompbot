import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";

vi.mock("../../src/agents/dispatch.js", () => ({
  dispatchToAgent: vi.fn(async () => ({ response: "ok", agentUsed: "Alfred" })),
}));
vi.mock("../../src/chat/title.js", () => ({ generateTitleInBackground: vi.fn() }));
vi.mock("../../src/memory/extractor.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractMemories: vi.fn(async () => []),
}));

const { handleChatMessage } = await import("../../src/chat/handler.js");

async function send(conversationId: string, deliveryChannel?: "telegram" | "discord" | "web-chat") {
  await handleChatMessage("hello", { conversationId, send: () => {} }, undefined, { deliveryChannel });
}

function insertChat(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title: "chat", createdAt: now, updatedAt: now }).run();
  return id;
}

const tagsOf = (id: string) => JSON.parse(db.select().from(conversations).where(eq(conversations.id, id)).get()!.tags) as string[];
const userSources = (id: string) => db.select().from(chatMessages).where(eq(chatMessages.conversationId, id)).all()
  .filter((m) => m.role === "user").map((m) => m.source);

test("a Telegram message is marked, and tags its chat once", async () => {
  const id = insertChat();

  await send(id, "telegram");
  await send(id, "telegram");

  expect(userSources(id)).toEqual(["telegram", "telegram"]);
  expect(tagsOf(id)).toEqual(["telegram"]);
});

test("a chat used from both keeps both tags and each message's own source", async () => {
  const id = insertChat();

  await send(id, "telegram");
  await send(id, "discord");

  expect(userSources(id)).toEqual(["telegram", "discord"]);
  expect(tagsOf(id)).toEqual(["telegram", "discord"]);
});

test("a tag the user already set stays", async () => {
  const id = insertChat();
  db.update(conversations).set({ tags: JSON.stringify(["work"]) }).where(eq(conversations.id, id)).run();

  await send(id, "discord");

  expect(tagsOf(id)).toEqual(["work", "discord"]);
});

test("someone else's message is labelled, told to the agent, and not saved as the user's memory", async () => {
  const { extractMemories } = await import("../../src/memory/extractor.js");
  const { dispatchToAgent } = await import("../../src/agents/dispatch.js");
  const id = insertChat();

  await handleChatMessage("I hate cilantro", { conversationId: id, send: () => {} }, undefined, { deliveryChannel: "discord", author: "Kari" });
  await new Promise((r) => setTimeout(r, 20));

  const stored = db.select().from(chatMessages).where(eq(chatMessages.conversationId, id)).all().find((m) => m.role === "user");
  expect(stored?.content).toBe("**Kari:** I hate cilantro");
  expect(vi.mocked(dispatchToAgent).mock.lastCall?.[0].prompt).toContain("[Written by Kari, not by the user you belong to.");
  expect(extractMemories).not.toHaveBeenCalled();

  await handleChatMessage("I hate cilantro", { conversationId: insertChat(), send: () => {} }, undefined, { deliveryChannel: "discord" });
  await vi.waitFor(() => expect(extractMemories).toHaveBeenCalledOnce());
  expect(vi.mocked(dispatchToAgent).mock.lastCall?.[0].prompt).not.toContain("Written by");
});

test("a web message gets no source and no tag", async () => {
  const id = insertChat();

  await send(id, "web-chat");
  await send(id);

  expect(userSources(id)).toEqual([null, null]);
  expect(tagsOf(id)).toEqual([]);
});
