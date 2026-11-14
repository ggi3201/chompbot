import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";

const pool = vi.hoisted(() => ({ busy: false, closed: [] as string[] }));
vi.mock("../../src/agents/runtime/pool.js", () => ({
  activeRuntime: () => ({ busy: pool.busy }),
  closeConversationRuntime: (id: string) => pool.closed.push(id),
}));
vi.mock("../../src/agents/dispatch.js", () => ({ dispatchToAgent: vi.fn() }));
vi.mock("../../src/chat/title.js", () => ({ generateTitleInBackground: vi.fn() }));
vi.mock("../../src/sync/import.js", () => ({ importSkills: () => ({ imported: 2, updated: 1, skipped: 0 }) }));
vi.mock("../../src/sync/mcp.js", () => ({ syncSkillsToCodex: vi.fn() }));
vi.mock("../../src/routes/plugins.js", () => ({
  listPlugins: async () => [{ name: "code-review", enabled: true }, { name: "vercel", enabled: false }],
}));

const { handleChatMessage } = await import("../../src/chat/handler.js");

function chat(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title: "chat", createdAt: now, updatedAt: now }).run();
  return id;
}
const lastReply = (id: string) =>
  db.select().from(chatMessages).where(eq(chatMessages.conversationId, id)).all().filter((m) => m.role === "assistant").at(-1)?.content;

beforeEach(() => {
  pool.busy = false;
  pool.closed = [];
});

test("/reload-skills syncs skills and restarts only this chat's session", async () => {
  const id = chat();
  await handleChatMessage("/reload-skills", { conversationId: id, send: () => {} });
  expect(lastReply(id)).toContain("Skills reloaded: 2 new, 1 updated.");
  expect(pool.closed).toEqual([id]);
});

test("/reload-plugins names what is switched on", async () => {
  const id = chat();
  await handleChatMessage("/reload-plugins", { conversationId: id, send: () => {} });
  expect(lastReply(id)).toContain("On: code-review.");
  expect(pool.closed).toEqual([id]);
});

test("a chat with an agent at work is left alone", async () => {
  pool.busy = true;
  const id = chat();
  await handleChatMessage("/reload-plugins", { conversationId: id, send: () => {} });
  expect(lastReply(id)).toContain("still working");
  expect(pool.closed).toEqual([]);
});
