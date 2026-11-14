import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { Client, REST, type ChatInputCommandInteraction, type Message } from "discord.js";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversations, proactiveRules, settings } from "../../src/db/schema.js";
import { saveSecret } from "../../src/lib/secrets.js";
import { replyCallbacks } from "../../src/mcp/state.js";

const { handleChatMessage, answerPendingQuestion } = vi.hoisted(() => ({
  handleChatMessage: vi.fn(),
  answerPendingQuestion: vi.fn(),
}));
vi.mock("../../src/chat/handler.js", () => ({ handleChatMessage }));
vi.mock("../../src/mcp/pending-questions.js", () => ({ answerPendingQuestion }));

const { getClient, restartBot, setLinkedChannelId, startDiscordBot } = await import("../../src/discord/bot.js");
const { handleDiscordCommand, handleDiscordMessage, resetDiscordConversation } = await import("../../src/discord/handlers.js");

const HOUR = 60 * 60 * 1000;
const OWNER = { id: "owner-id", bot: false, displayName: "alex" };
const WIFE = { id: "wife-id", bot: false, displayName: "solkrem" };
const GUEST = { id: "guest-id", bot: false, displayName: "guest" };

const flush = () => new Promise((r) => setTimeout(r, 5));

function fakeMessage(author: object, content = "hello") {
  return {
    author,
    content,
    mentions: { users: new Map() },
    attachments: new Map(),
    channel: { sendTyping: async () => {} },
    reply: vi.fn(async () => ({ id: "sent" })),
  } as unknown as Message;
}

const lastOptions = () => handleChatMessage.mock.lastCall?.[3] as { author?: string };
const lastConversation = () => (handleChatMessage.mock.lastCall?.[1] as { conversationId: string }).conversationId;

function chat(id: string, ageMs: number): string {
  const at = new Date(Date.now() - ageMs).toISOString();
  db.insert(conversations).values({ id, title: id, createdAt: at, updatedAt: at }).run();
  return id;
}

function makeCurrent(id: string) {
  resetDiscordConversation();
  db.update(settings).set({ value: id }).where(eq(settings.key, "discord_conversation_id")).run();
}

beforeAll(async () => {
  saveSecret("DISCORD_BOT_TOKEN", "test-token");
  vi.spyOn(Client.prototype, "login").mockResolvedValue("test-token");
  vi.spyOn(REST.prototype, "put").mockResolvedValue([]);
  db.insert(settings).values({ key: "discord_user_names", value: JSON.stringify({ [WIFE.id]: "Kari" }) }).run();
  startDiscordBot();
  getClient()!.emit("ready", {
    user: { id: "bot-id", tag: "Chomp#0001" },
    application: { fetch: async () => ({ owner: { id: OWNER.id } }) },
  } as never);
  await flush();
});

afterAll(async () => {
  await getClient()?.destroy();
});

beforeEach(() => {
  handleChatMessage.mockReset();
  answerPendingQuestion.mockReset();
  resetDiscordConversation();
});

test("a failed reply in a listener is logged instead of killing the process", async () => {
  setLinkedChannelId("linked");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  getClient()!.emit("interactionCreate", {
    channelId: "elsewhere",
    isRepliable: () => true,
    reply: async () => { throw new Error("Invalid Form Body"); },
  } as never);
  await flush();

  expect(logged.mock.calls.some(([label]) => label === "[discord] Client error:")).toBe(true);
  logged.mockRestore();
});

test("starting the bot again does not register the reply callbacks twice", async () => {
  const before = replyCallbacks.length;
  await restartBot();
  expect(replyCallbacks.length).toBe(before);
});

test("a plain message continues an active chat; after 6 quiet hours it starts a new chat and stays there", async () => {
  const active = chat(`active-${Date.now()}`, HOUR);
  makeCurrent(active);
  await handleDiscordMessage(fakeMessage(OWNER));
  expect(lastConversation()).toBe(active);

  const stale = chat(`stale-${Date.now()}`, 7 * HOUR);
  makeCurrent(stale);

  await handleDiscordMessage(fakeMessage(OWNER));
  const fresh = lastConversation();
  expect(fresh).not.toBe(stale);

  await handleDiscordMessage(fakeMessage(OWNER));
  expect(lastConversation()).toBe(fresh);
});

test("/resume keeps the chat it resumed, even an old one", async () => {
  db.update(conversations).set({ updatedAt: new Date(Date.now() - 48 * HOUR).toISOString() }).run();
  const old = chat(`old-${Date.now()}`, 7 * HOUR);
  const reply = vi.fn(async () => {});
  await handleDiscordCommand({ options: { getString: () => null }, reply } as unknown as ChatInputCommandInteraction, "resume");
  expect(reply).toHaveBeenCalledWith(expect.stringContaining(old));

  await handleDiscordMessage(fakeMessage(OWNER));
  expect(lastConversation()).toBe(old);
});

test("the owner's messages carry no author, anyone else's carry their name", async () => {
  await handleDiscordMessage(fakeMessage(OWNER));
  expect(lastOptions().author).toBeUndefined();

  await handleDiscordMessage(fakeMessage(WIFE));
  expect(lastOptions().author).toBe("Kari");

  await handleDiscordMessage(fakeMessage(GUEST));
  expect(lastOptions().author).toBe("guest");
});

test("a question only takes an answer from the person who was asked", async () => {
  answerPendingQuestion.mockReturnValue(true);
  handleChatMessage.mockImplementationOnce(async (_text, chatCtx) => {
    chatCtx.send({ type: "question", sessionId: "session-1", question: "Which one?" });
  });
  await handleDiscordMessage(fakeMessage(OWNER, "start"));

  await handleDiscordMessage(fakeMessage(WIFE, "what's for dinner?"));
  expect(answerPendingQuestion).not.toHaveBeenCalled();
  expect(handleChatMessage).toHaveBeenLastCalledWith("what's for dinner?", expect.anything(), undefined, expect.anything());

  await handleDiscordMessage(fakeMessage(OWNER, "the first"));
  expect(answerPendingQuestion).toHaveBeenCalledWith("session-1", "the first");
});

test("a command reply over Discord's limit is split instead of rejected", async () => {
  const name = "a rule with quite a long name to fill the message up ".repeat(2);
  db.insert(proactiveRules).values(
    Array.from({ length: 60 }, (_, i) => ({ id: `long-${i}`, name, triggerType: "time", actionType: "agent" })),
  ).run();
  const reply = vi.fn(async () => {});
  const followUp = vi.fn(async () => {});

  await handleDiscordCommand({ options: { getString: () => null }, reply, followUp } as unknown as ChatInputCommandInteraction, "rules");
  db.delete(proactiveRules).run();

  const parts = [...reply.mock.calls, ...followUp.mock.calls].map(([text]) => text as unknown as string);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((p) => p.length <= 2000)).toBe(true);
  expect(parts.join("\n").match(/a rule with/g)).toHaveLength(120);
});
