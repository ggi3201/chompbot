import { randomUUID } from "crypto";
import { beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { chatMessages, conversations } from "../../src/db/schema.js";

const notify = vi.hoisted(() => vi.fn(async () => "telegram"));
const dispatchToAgent = vi.hoisted(() => vi.fn());

vi.mock("../../src/notifications/router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notify,
}));
vi.mock("../../src/agents/dispatch.js", () => ({ dispatchToAgent }));

const { sendTurnNotice } = await import("../../src/agents/turn-notice.js");
const { resumeInterruptedTurns } = await import("../../src/agents/runtime/resume.js");

const RUN_STARTED = "2026-01-01T07:00:00.000Z";

function insertChat(resumeTurn?: object): string {
  const id = randomUUID();
  db.insert(conversations).values({
    id,
    title: "Proactive: test",
    createdAt: RUN_STARTED,
    updatedAt: RUN_STARTED,
    resumeTurn: resumeTurn ? JSON.stringify(resumeTurn) : null,
  }).run();
  return id;
}

function insertReply(conversationId: string, content: string, createdAt: string): void {
  db.insert(chatMessages).values({ id: randomUUID(), conversationId, role: "assistant", content, createdAt }).run();
}

function noticeFor(conversationId: string) {
  return { type: "agent-complete" as const, title: "Daily", conversationId, since: RUN_STARTED, channels: ["telegram" as const] };
}

function interruptedRule(notifyWhenDone = true): string {
  const id = randomUUID();
  db.insert(conversations).values({ id, title: "Proactive: test", createdAt: RUN_STARTED, updatedAt: RUN_STARTED }).run();
  const options = { provider: "claude", ...(notifyWhenDone ? { notifyWhenDone: noticeFor(id) } : {}) };
  db.update(conversations).set({ resumeTurn: JSON.stringify({ agent: "Alfred", options }) }).where(eq(conversations.id, id)).run();
  return id;
}

beforeEach(() => {
  // Test files share one database, and resumeInterruptedTurns resumes every saved turn in it.
  db.update(conversations).set({ resumeTurn: null }).run();
  notify.mockClear();
  dispatchToAgent.mockReset();
});

test("a notice sends the run's replies, not what came before it", async () => {
  const id = insertChat();
  insertReply(id, "earlier run", "2026-01-01T06:00:00.000Z");
  insertReply(id, "first", "2026-01-01T07:01:00.000Z");
  insertReply(id, "second", "2026-01-01T07:02:00.000Z");

  await expect(sendTurnNotice(noticeFor(id), "final text")).resolves.toBe("first\n\nsecond");
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Daily", body: "first\n\nsecond", broadcast: true, channels: ["telegram"], conversationId: id }));
});

test("a notice falls back to the final text, and stays quiet with nothing to say", async () => {
  await expect(sendTurnNotice(noticeFor(insertChat()), "final text")).resolves.toBe("final text");
  notify.mockClear();

  await expect(sendTurnNotice(noticeFor(insertChat()), "")).resolves.toBeUndefined();
  expect(notify).not.toHaveBeenCalled();
});

test("a run that ends on exactly [SILENT] sends nothing", async () => {
  await expect(sendTurnNotice(noticeFor(insertChat()), " [SILENT]\n")).resolves.toBeUndefined();

  const id = insertChat();
  insertReply(id, "[SILENT]", "2026-01-01T07:01:00.000Z");
  await expect(sendTurnNotice(noticeFor(id), "[SILENT]")).resolves.toBeUndefined();

  expect(notify).not.toHaveBeenCalled();

  // Only an exact [SILENT] keeps a run quiet.
  await expect(sendTurnNotice(noticeFor(insertChat()), "Oslo is closed, so [SILENT] today")).resolves.toBe("Oslo is closed, so [SILENT] today");
  expect(notify).toHaveBeenCalledTimes(1);
});

test("a rule interrupted by a restart still sends its message when it finishes", async () => {
  const id = interruptedRule();
  insertReply(id, "before the restart", "2026-01-01T07:01:00.000Z");
  dispatchToAgent.mockResolvedValue({ response: "after the restart", agentUsed: "Alfred" });

  await resumeInterruptedTurns();

  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Daily", channels: ["telegram"], body: expect.stringContaining("after the restart") }));
  expect(notify.mock.calls[0]).toEqual([expect.objectContaining({ body: expect.stringContaining("before the restart") })]);
});

test("a rule that cannot resume says so instead of going quiet", async () => {
  interruptedRule();
  dispatchToAgent.mockRejectedValue(new Error("session lost"));

  await resumeInterruptedTurns();

  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Daily", body: expect.stringContaining("session lost") }));
});

test("a normal chat resumes without a notification", async () => {
  interruptedRule(false);
  dispatchToAgent.mockResolvedValue({ response: "done", agentUsed: "Alfred" });

  await resumeInterruptedTurns();

  expect(notify).not.toHaveBeenCalled();
});
