import { beforeEach, expect, test, vi } from "vitest";
import type { Context } from "grammy";
import { db } from "../../src/db/index.js";
import { conversations, telegramMessageLinks } from "../../src/db/schema.js";

const { handleChatMessage, answerPendingQuestion, transcribeAudio } = vi.hoisted(() => ({
  handleChatMessage: vi.fn(),
  answerPendingQuestion: vi.fn(),
  transcribeAudio: vi.fn(),
}));
vi.mock("../../src/routes/voice.js", () => ({ transcribeAudio }));
vi.mock("../../src/chat/handler.js", () => ({ handleChatMessage }));
vi.mock("../../src/mcp/pending-questions.js", () => ({ answerPendingQuestion }));

const { handleCallbackQuery, handleNewConversation, handleTelegramMessage } = await import("../../src/telegram/handlers.js");
const { getConversationForTelegramMsg, trackSentMessage } = await import("../../src/telegram/tracking.js");

let nextMsgId = 1000;
const flush = () => new Promise((r) => setTimeout(r, 5));

function fakeCtx(message: object, callbackQuery?: object) {
  const replies: Array<{ id: number; html: string }> = [];
  const ctx = {
    chat: { id: 1 },
    message,
    callbackQuery,
    reply: vi.fn(async (html: string) => {
      const id = nextMsgId++;
      replies.push({ id, html });
      return { message_id: id };
    }),
    answerCallbackQuery: vi.fn(async () => {}),
    replyWithChatAction: vi.fn(async () => {}),
  };
  return { ctx: ctx as unknown as Context, replies, answer: ctx.answerCallbackQuery };
}

function chat(id: string, title = id): string {
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title, createdAt: now, updatedAt: now }).run();
  return id;
}

let suffix = 0;

beforeEach(async () => {
  suffix++;
  db.delete(telegramMessageLinks).run();
  handleChatMessage.mockReset();
  answerPendingQuestion.mockReset();
  await handleNewConversation(fakeCtx({}).ctx);
});

test("a reply is headed with its chat and every part is linked for swiping", async () => {
  const id = chat(`long-${suffix}`, "Long chat");
  trackSentMessage(1, id);
  handleChatMessage.mockImplementation(async (_text, chatCtx) => {
    chatCtx.send({ type: "done", content: "word ".repeat(1500) });
  });
  const { ctx, replies } = fakeCtx({ text: "go", reply_to_message: { message_id: 1, from: { is_bot: true }, text: "earlier" } });
  await handleTelegramMessage(ctx);
  await flush();

  expect(replies.length).toBeGreaterThan(1);
  expect(replies[0].html).toContain("Long chat");
  for (const r of replies) expect(getConversationForTelegramMsg(r.id)).toBe(id);
});

test("swiping into a chat makes the next plain message continue there", async () => {
  const id = chat(`sticky-${suffix}`);
  trackSentMessage(2, id);
  handleChatMessage.mockImplementation(async () => {});
  await handleTelegramMessage(fakeCtx({ text: "a", reply_to_message: { message_id: 2, from: { is_bot: true } } }).ctx);
  await handleTelegramMessage(fakeCtx({ text: "b" }).ctx);
  expect(handleChatMessage.mock.calls[1][1].conversationId).toBe(id);
});

/** Start a run in `id` that asks a question, leaving it pending. */
async function askIn(id: string) {
  trackSentMessage(100 + suffix, id);
  handleChatMessage.mockImplementationOnce(async (_text, chatCtx) => {
    chatCtx.send({ type: "question", sessionId: "s1", question: "Which one?" });
  });
  await handleTelegramMessage(fakeCtx({ text: "start", reply_to_message: { message_id: 100 + suffix, from: { is_bot: true } } }).ctx);
}

test("a plain message answers a question waiting in the current chat", async () => {
  await askIn(chat(`q-plain-${suffix}`, "Question chat"));
  answerPendingQuestion.mockReturnValue(true);
  const { ctx, replies } = fakeCtx({ text: "the red one" });
  await handleTelegramMessage(ctx);

  expect(answerPendingQuestion).toHaveBeenCalledWith("s1", "the red one");
  expect(replies[0].html).toContain("Question chat");
  expect(handleChatMessage).toHaveBeenCalledTimes(1);
});

test("a swipe into another chat is not swallowed by the waiting question", async () => {
  await askIn(chat(`q-other-${suffix}`));
  const other = chat(`other-${suffix}`);
  trackSentMessage(3, other);
  handleChatMessage.mockImplementation(async () => {});
  await handleTelegramMessage(fakeCtx({ text: "unrelated", reply_to_message: { message_id: 3, from: { is_bot: true } } }).ctx);

  expect(answerPendingQuestion).not.toHaveBeenCalled();
  expect(handleChatMessage.mock.calls[1][1].conversationId).toBe(other);
});

test("an expired question falls through to a normal message", async () => {
  await askIn(chat(`q-expired-${suffix}`));
  answerPendingQuestion.mockReturnValue(false);
  handleChatMessage.mockImplementation(async () => {});
  await handleTelegramMessage(fakeCtx({ text: "hello?" }).ctx);
  expect(handleChatMessage).toHaveBeenCalledTimes(2);
});

test("a button only answers the question it was sent with", async () => {
  const id = chat(`q-button-${suffix}`);
  await askIn(id);
  answerPendingQuestion.mockReturnValue(true);

  const stale = chat(`stale-button-${suffix}`);
  trackSentMessage(4, stale);
  const wrong = fakeCtx({}, { data: "yes", message: { message_id: 4 } });
  await handleCallbackQuery(wrong.ctx);
  expect(answerPendingQuestion).not.toHaveBeenCalled();
  expect(wrong.answer).toHaveBeenCalledWith({ text: "No pending question — please type your reply." });

  trackSentMessage(5, id);
  await handleCallbackQuery(fakeCtx({}, { data: "yes", message: { message_id: 5 } }).ctx);
  expect(answerPendingQuestion).toHaveBeenCalledWith("s1", "yes");
});

test("picking an old chat in /chats sticks, despite the idle rule", async () => {
  const at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const id = `picked-${suffix}`;
  db.insert(conversations).values({ id, title: "Old chat", createdAt: at, updatedAt: at }).run();

  const { ctx, replies } = fakeCtx({}, { data: `chat:${id}` });
  await handleCallbackQuery(ctx);
  expect(replies[0].html).toContain("Old chat");

  handleChatMessage.mockImplementation(async () => {});
  await handleTelegramMessage(fakeCtx({ text: "picking this up" }).ctx);
  expect(handleChatMessage.mock.calls[0][1].conversationId).toBe(id);
});

function voiceCtx(message: object) {
  const fake = fakeCtx({ voice: { file_id: "f1", mime_type: "audio/ogg" }, ...message });
  Object.assign(fake.ctx, { api: { token: "t", getFile: vi.fn(async () => ({ file_path: "voice/f1.oga" })) } });
  return fake;
}

function stubTelegramDownload() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
}

test("a voice message runs as its transcript, swiped into the chat it answers, and says what it heard", async () => {
  stubTelegramDownload();
  transcribeAudio.mockResolvedValue(" Nudge the landlord ");
  handleChatMessage.mockResolvedValue(undefined);
  const id = chat(`voice-${suffix}`);
  trackSentMessage(7, id);

  const { ctx, replies } = voiceCtx({ reply_to_message: { message_id: 7, from: { is_bot: true } } });
  await handleTelegramMessage(ctx);
  await flush();
  vi.unstubAllGlobals();

  expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), "audio/ogg");
  expect(replies[0].html).toBe("Heard: Nudge the landlord");
  expect(handleChatMessage).toHaveBeenCalledTimes(1);
  expect(handleChatMessage.mock.calls[0][0]).toContain("Nudge the landlord");
  expect(handleChatMessage.mock.calls[0][1]).toMatchObject({ conversationId: id });
});

test("when transcription fails or comes back empty, nothing reaches the agent", async () => {
  const cases: Array<[string, () => void]> = [
    ["fails", () => transcribeAudio.mockRejectedValue(new Error("down"))],
    ["comes back empty", () => transcribeAudio.mockResolvedValue("  ")],
  ];
  for (const [name, arrange] of cases) {
    stubTelegramDownload();
    arrange();
    const { ctx, replies } = voiceCtx({});
    await handleTelegramMessage(ctx);
    await flush();
    vi.unstubAllGlobals();

    expect(handleChatMessage, name).not.toHaveBeenCalled();
    expect(replies[0].html, name).toContain("couldn't make out");
  }
});
