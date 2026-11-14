import express from "express";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";
import { saveSecret } from "../../src/lib/secrets.js";

const dispatchToAgent = vi.hoisted(() => vi.fn());
vi.mock("../../src/agents/dispatch.js", () => ({ dispatchToAgent }));

const { default: outsideMcpRoutes, outsideAgent } = await import("../../src/routes/outside-mcp.js");

const TOKEN = "mac-token-0123456789abcdef-xyz";
const CHAT = "0a0a0a0a-4444-4444-8444-444444444444";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let url: string;

const rpc = (method: string, params: Record<string, unknown> = {}, token = TOKEN) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});
const call = async (name: string, args: Record<string, unknown>) =>
  (await (await rpc("tools/call", { name, arguments: args })).json()).result as { content: { text: string }[]; isError: boolean; structuredContent?: { status: string; ticket: string; reply: string; chats?: { conversationId: string; from: string; ticket: string; status: string }[] } };

beforeAll(async () => {
  saveSecret("AGENT_TOKEN_CLAUDE_MAC", TOKEN);
  saveSecret("AGENT_TOKEN_WEAK", "short");
  const app = express();
  app.use(express.json());
  app.use("/outside-mcp", outsideMcpRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/outside-mcp`;
  const now = new Date().toISOString();
  db.insert(conversations).values({ id: CHAT, title: "Foodie onboarding", createdAt: now, updatedAt: now }).onConflictDoNothing().run();
});
afterAll(() => server.close());
beforeEach(() => dispatchToAgent.mockReset());

test("only a stored token of fair length gets in, named after its secret", async () => {
  expect(outsideAgent(`Bearer ${TOKEN}`)).toBe("CLAUDE MAC");
  expect(outsideAgent("Bearer short")).toBeNull();
  expect(outsideAgent(undefined)).toBeNull();
  expect((await rpc("tools/list", {}, "not-a-token-not-a-token-x")).status).toBe(401);
});

test("speaks MCP: initialize, notifications, tools/list with only the narrow set, and refuses any other tool", async () => {
  const init = await (await rpc("initialize", { protocolVersion: "2025-03-26" })).json();
  expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "chomp" } });

  const note = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  expect(note.status).toBe(202);

  const names = (await (await rpc("tools/list")).json()).result.tools.map((tool: { name: string }) => tool.name).sort();
  expect(names).toEqual(["get_conversation_messages", "get_reply", "list_conversations", "message_chat", "my_chats", "recall_memories", "save_memory", "search_conversations", "start_chat"]);

  // Tools outside the narrow set are refused even when called by name.
  expect(await call("send_imessage", { to: "x", text: "y" })).toMatchObject({ isError: true, content: [{ text: "Unknown tool: send_imessage" }] });
});

test("reaches Chomp's memories", async () => {
  expect((await call("save_memory", { content: "Outside agents can save memories", category: "facts" })).content[0].text).toMatch(/^Memory saved/);
  expect((await call("recall_memories", { query: "Outside agents can save", use_semantic: false })).content[0].text).toContain("Outside agents can save memories");
});

test("message_chat runs a labelled turn in the chat and, with wait, returns its answer", async () => {
  dispatchToAgent.mockResolvedValue({ response: "The onboarding has three screens.", agentUsed: "Alfred" });

  const result = await call("message_chat", { conversationId: CHAT.slice(0, 8), message: "How many screens?", from: "foodie worktree: onboarding", wait: true });

  expect(result.isError).toBe(false);
  expect(result.content[0].text).toBe(`"Foodie onboarding" (chat ${CHAT}, http://127.0.0.1:${new URL(url).port}/chat/${CHAT}) answered:\n\nThe onboarding has three screens.`);
  const stored = db.select().from(chatMessages).where(eq(chatMessages.conversationId, CHAT)).all().map((m) => m.content);
  expect(stored).toContain("**From CLAUDE MAC (foodie worktree: onboarding), outside Chomp:** How many screens?");
});

test("a message must say which session sent it", async () => {
  expect((await call("message_chat", { conversationId: CHAT, message: "Hi" })).content[0].text).toMatch(/^from is missing/);
  expect((await call("start_chat", { message: "Hi", from: "   " })).isError).toBe(true);
});

test("start_chat opens a new chat tagged with the agent, links to it, and refuses a project that does not exist", async () => {
  dispatchToAgent.mockResolvedValue({ response: "On it.", agentUsed: "Alfred" });
  const sent = (await call("start_chat", { message: "Plan the week", from: "home: planning" })).content[0].text;
  const id = sent.match(/chat ([0-9a-f-]{36}),/)![1];
  expect(sent).toContain(`/chat/${id})`);
  expect(JSON.parse(db.select().from(conversations).where(eq(conversations.id, id)).get()!.tags)).toEqual(["claude mac"]);
  expect(await call("start_chat", { message: "Fix it", project: "no-such-repo", from: "home: planning" })).toMatchObject({ isError: true });
});

test("without wait the answer is not lost: the reply ticket gets it with get_reply once the turn ends", async () => {
  let finish!: (value: { response: string; agentUsed: string }) => void;
  dispatchToAgent.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

  const sent = await call("message_chat", { conversationId: CHAT, message: "Check the GPU", from: "mac: preview" });
  const ticket = sent.structuredContent!.ticket;
  expect(ticket).toMatch(new RegExp(`^${CHAT}@\\d{4}-`));
  expect(sent.content[0].text).toContain(`Reply ticket: ${ticket}`);

  const early = await call("get_reply", { ticket });
  expect(early.structuredContent).toMatchObject({ status: "working", reply: "" });
  expect(early.content[0].text).toContain(`ticket ${ticket}`);

  finish({ response: "The 780M draws it now.", agentUsed: "Alfred" });
  const done = await call("get_reply", { ticket, wait: true });
  expect(done.structuredContent).toMatchObject({ status: "answered", reply: "The 780M draws it now." });
  expect(done.content[0].text).toMatch(/answered:\n\nThe 780M draws it now\.$/);
});

test("get_reply refuses a ticket it cannot read or a chat that does not exist", async () => {
  expect((await call("get_reply", { ticket: "nonsense" })).isError).toBe(true);
  expect((await call("get_reply", { ticket: `${CHAT}@not-a-time` })).isError).toBe(true);
  expect((await call("get_reply", { ticket: `ffffffff-0000-4000-8000-000000000000@${new Date().toISOString()}` })).isError).toBe(true);
});

test("a turn a restart interrupted counts as still working until it resumes", async () => {
  db.update(conversations).set({ resumeTurn: JSON.stringify({ agent: "Alfred", options: {} }) }).where(eq(conversations.id, CHAT)).run();
  const ticket = `${CHAT}@${new Date(Date.now() - 60_000).toISOString()}`;
  expect((await call("get_reply", { ticket })).structuredContent).toMatchObject({ status: "working" });
  db.update(conversations).set({ resumeTurn: null }).where(eq(conversations.id, CHAT)).run();
  expect((await call("get_reply", { ticket })).structuredContent).toMatchObject({ status: "answered" });
});

test("my_chats lists the chats this agent wrote to, newest first, with the session that wrote last and a ticket", async () => {
  const mine = "1b1b1b1b-5555-4555-8555-555555555555";
  const theirs = "2c2c2c2c-6666-4666-8666-666666666666";
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  db.insert(conversations).values([
    { id: mine, title: "Simulator spike", createdAt: at(0), updatedAt: at(0) },
    { id: theirs, title: "Codex chat", createdAt: at(0), updatedAt: at(0) },
  ]).run();
  db.insert(chatMessages).values([
    { id: "mc1", conversationId: mine, role: "user", content: "**From CLAUDE MAC (sim worktree: spike), outside Chomp:** Try serve-sim", createdAt: at(60) },
    { id: "mc2", conversationId: mine, role: "user", content: "**From CLAUDE MAC (home: notes), outside Chomp:** Any news?", createdAt: at(61) },
    { id: "mc3", conversationId: theirs, role: "user", content: "**From CODEX (codex: x), outside Chomp:** Hi", createdAt: at(62) },
  ]).run();

  const all = (await call("my_chats", {})).structuredContent!.chats!;
  expect(all[0]).toMatchObject({ conversationId: mine, from: "home: notes", status: "answered" });
  expect(all[0].ticket).toBe(`${mine}@${db.select().from(chatMessages).where(eq(chatMessages.id, "mc2")).get()!.createdAt}`);
  expect(all.map((c) => c.conversationId)).toContain(CHAT);
  expect(all.map((c) => c.conversationId)).not.toContain(theirs);

  const spike = (await call("my_chats", { from: "SIM WORKTREE" })).structuredContent!.chats!;
  expect(spike).toEqual([expect.objectContaining({ conversationId: mine, from: "sim worktree: spike" })]);
  expect((await call("my_chats", { from: "no such session" })).content[0].text).toMatch(/^None of your chats/);
});
