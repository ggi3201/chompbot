import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../../src/db/index.js";
import { chatItems, chatMessages, conversations } from "../../src/db/schema.js";
import type { TurnRequest } from "../../src/agents/runtime/types.js";

/** The SDK's live session, fed by the test: each pushed message is what Claude Code emits next. */
const stream = vi.hoisted(() => {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    push(message: unknown) {
      queue.push(message);
      wake?.();
    },
    async *messages() {
      for (;;) {
        while (queue.length) yield queue.shift();
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    Object.assign(stream.messages(), {
      interrupt: async () => {},
      close: () => {},
      setModel: async () => {},
      applyFlagSettings: async () => {},
      setPermissionMode: async () => {},
      getContextUsage: () => Promise.reject(new Error("not in tests")),
    }),
}));

const { ClaudeRuntime } = await import("../../src/agents/runtime/claude.js");
const { deliverWakeTurn } = await import("../../src/agents/runtime/wake.js");

const CONV = "wake-test-conv";
const NOW = "2026-11-03T12:00:00.000Z";

function request(): TurnRequest {
  return { sessionId: "turn-1", conversationId: CONV, agentName: "Claude Code", prompt: "transcribe it", access: "full", cwd: "/tmp", ctx: { conversationId: CONV, send: () => {} } };
}

function assistant(id: string, text: string, parent: string | null = null): SDKMessage {
  return { type: "assistant", uuid: `${id}-uuid`, session_id: "s", parent_tool_use_id: parent, message: { id, content: [{ type: "text", text }] } } as unknown as SDKMessage;
}

function result(text: string): SDKMessage {
  return { type: "result", subtype: "success", result: text } as unknown as SDKMessage;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  db.insert(conversations).values({ id: CONV, createdAt: NOW, updatedAt: NOW }).onConflictDoNothing().run();
  db.delete(chatItems).where(eq(chatItems.conversationId, CONV)).run();
  db.delete(chatMessages).where(eq(chatMessages.conversationId, CONV)).run();
});

describe("a turn Claude Code starts on its own", () => {
  test("is opened, recorded and handed to onWake instead of being dropped", async () => {
    const runtime = ClaudeRuntime.start(CONV, request());
    const wakes: { request: TurnRequest; done: Promise<string> }[] = [];
    runtime.onWake = (wakeRequest, done) => wakes.push({ request: wakeRequest, done });

    const first = runtime.runTurn(request());
    stream.push(assistant("m1", "Waiting for the benchmark."));
    stream.push(result("Waiting for the benchmark."));
    expect(await first).toBe("Waiting for the benchmark.");
    expect(runtime.busy).toBe(false);

    // A background subagent still talking after the turn ended is not a turn of its own.
    stream.push(assistant("sub", "grep output", "toolu_agent"));
    await flush();
    expect(wakes).toHaveLength(0);

    // The background task finished: the session answers without a user message.
    stream.push(assistant("m2", "109 seconds on the GPU."));
    await flush();
    expect(wakes).toHaveLength(1);
    expect(runtime.busy).toBe(true);
    const wake = wakes[0];
    expect(wake.request).toMatchObject({ conversationId: CONV, agentName: "Claude Code" });
    expect(wake.request.sessionId).not.toBe("turn-1");

    stream.push(result("109 seconds on the GPU."));
    expect(await wake.done).toBe("109 seconds on the GPU.");
    expect(runtime.busy).toBe(false);

    const items = db.select().from(chatItems).where(eq(chatItems.turnId, wake.request.sessionId)).all();
    expect(items.map((item) => JSON.parse(item.payload).text)).toContain("109 seconds on the GPU.");
    runtime.close();
  });

  test("its answer is saved as the chat's next assistant message", async () => {
    const sent: object[] = [];
    const wakeRequest = { ...request(), sessionId: "wake-1", ctx: { conversationId: CONV, send: (payload: object) => sent.push(payload) } };
    await deliverWakeTurn(wakeRequest, Promise.resolve("Done: 109 s on the 6900 XT."));

    const rows = db.select().from(chatMessages).where(eq(chatMessages.conversationId, CONV)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "assistant", content: "Done: 109 s on the 6900 XT.", turnId: "wake-1", agentUsed: "Claude Code" });
    expect(sent).toContainEqual(expect.objectContaining({ type: "done", content: "Done: 109 s on the 6900 XT.", turnId: "wake-1" }));
  });
});
