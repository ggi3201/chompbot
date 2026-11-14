import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../../src/db/index.js";
import { chatItems, chatMessages, conversations } from "../../src/db/schema.js";
import type { TurnRequest } from "../../src/agents/runtime/types.js";

/** The SDK's live session, fed by the test. Closing it ends the stream, like the real CLI exiting. */
const session = vi.hoisted(() => {
  let queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    reset() {
      queue = [];
      closed = false;
    },
    push(message: unknown) {
      queue.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *messages() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    Object.assign(session.messages(), {
      interrupt: async () => {},
      close: () => session.close(),
      setModel: async () => {},
      applyFlagSettings: async () => {},
      setPermissionMode: async () => {},
      getContextUsage: () => Promise.reject(new Error("not in tests")),
    }),
}));

const { ClaudeRuntime } = await import("../../src/agents/runtime/claude.js");

const CONV = "subagent-test-conv";
const NOW = "2026-11-04T12:00:00.000Z";

function request(sessionId: string): TurnRequest {
  return { sessionId, conversationId: CONV, agentName: "Claude Code", prompt: "go", access: "full", cwd: "/tmp", ctx: { conversationId: CONV, send: () => {} } };
}

// The shapes below are what `claude` 2.1.318 emitted in a raw SDK probe of each case.
const system = (fields: object) => ({ type: "system", uuid: "u", session_id: "s", ...fields }) as unknown as SDKMessage;
const taskStarted = (toolUseId: string, taskType = "local_agent") =>
  system({ subtype: "task_started", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, description: "Long research", subagent_type: "Explore", task_type: taskType, is_backgrounded: true });
const taskProgress = (toolUseId: string, toolUses: number) =>
  system({ subtype: "task_progress", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, description: "Reading a.ts", usage: { total_tokens: 100, tool_uses: toolUses, duration_ms: 5000 } });
const taskEnded = (toolUseId: string, status: string, summary: string) =>
  system({ subtype: "task_notification", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, status, summary, output_file: "/tmp/out", usage: { total_tokens: 200, tool_uses: 5, duration_ms: 90000 } });

function subagentCall(parent: string, callId: string): SDKMessage {
  return { type: "assistant", uuid: `${callId}-uuid`, session_id: "s", parent_tool_use_id: parent, message: { id: callId, content: [{ type: "tool_use", id: callId, name: "Bash", input: { command: "make" } }] } } as unknown as SDKMessage;
}

function subagentCallResult(parent: string, callId: string): SDKMessage {
  return { type: "user", session_id: "s", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "ok" }] } } as unknown as SDKMessage;
}

function assistant(id: string, text: string): SDKMessage {
  return { type: "assistant", uuid: `${id}-uuid`, session_id: "s", parent_tool_use_id: null, message: { id, content: [{ type: "text", text }] } } as unknown as SDKMessage;
}

function result(text: string, fields: object = {}): SDKMessage {
  return { type: "result", subtype: "success", result: text, ...fields } as unknown as SDKMessage;
}

/** Long enough for a coalesced write (80 ms) to land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 120));

function row(id: string) {
  const found = db.select().from(chatItems).where(eq(chatItems.id, id)).get();
  return found ? JSON.parse(found.payload) : undefined;
}

function start() {
  session.reset();
  return ClaudeRuntime.start(CONV, request("first"));
}

beforeEach(() => {
  db.insert(conversations).values({ id: CONV, createdAt: NOW, updatedAt: NOW }).onConflictDoNothing().run();
  db.update(conversations).set({ ccSessionId: null }).where(eq(conversations.id, CONV)).run();
  db.delete(chatItems).where(eq(chatItems.conversationId, CONV)).run();
  db.delete(chatMessages).where(eq(chatMessages.conversationId, CONV)).run();
});

describe("a background subagent that outlives its turn", () => {
  test("stays running after the turn ends, then shows its real outcome", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(subagentCall("agent", "call-1"));
    session.push(result("Launched."));
    expect(await turn).toBe("Launched.");

    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "running" });
    expect(row("turn-1:call-1")).toMatchObject({ status: "running" });
    expect(runtime.hasLiveAgents).toBe(true);

    session.push(taskProgress("agent", 3));
    session.push(subagentCallResult("agent", "call-1"));
    session.push(subagentCall("agent", "call-2"));
    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "running", toolUses: 3, lastActivity: "Reading a.ts" });
    expect(row("turn-1:call-1")).toMatchObject({ status: "completed" });
    expect(row("turn-1:call-2")).toBeDefined();

    session.push(taskEnded("agent", "completed", "Found it."));
    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "completed", summary: "Found it.", toolUses: 5, durationMs: 90000 });
    expect(runtime.hasLiveAgents).toBe(false);
    runtime.close();
  });

  test("its failure shows too", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(result("Launched."));
    await turn;

    session.push(taskEnded("agent", "failed", "It broke."));
    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "failed", summary: "It broke." });
    runtime.close();
  });

  test("that finishes during a later turn updates the row of the turn that started it", async () => {
    const runtime = start();
    const first = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(result("Launched."));
    await first;

    const second = runtime.runTurn(request("turn-2"));
    session.push(taskEnded("agent", "completed", "Found it."));
    session.push(result("Second answer."));
    expect(await second).toBe("Second answer.");

    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "completed", summary: "Found it." });
    expect(row("turn-2:subagent:agent")).toBeUndefined();
    runtime.close();
  });

  test("that ends after its turn closes the calls it left open", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(subagentCall("agent", "call-1"));
    session.push(result("Launched."));
    await turn;

    session.push(taskEnded("agent", "stopped", "Stopped by TaskStop."));
    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "stopped" });
    expect(row("turn-1:call-1").status).not.toBe("running");
    runtime.close();
  });

  test("stops when the session closes, because the CLI takes it down", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(subagentCall("agent", "call-1"));
    session.push(result("Launched."));
    await turn;

    runtime.close();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "stopped" });
    expect(row("turn-1:call-1").status).not.toBe("running");
    expect(runtime.hasLiveAgents).toBe(false);
  });

  test("stops when the CLI dies on its own", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(result("Launched."));
    await turn;

    session.close();
    await settled();
    expect(row("turn-1:subagent:agent")).toMatchObject({ status: "stopped" });
    expect(runtime.hasLiveAgents).toBe(false);
  });

  test("restarts the idle clock when it ends, so the sweep cannot beat its wake turn", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("agent"));
    session.push(result("Launched."));
    await turn;

    const before = runtime.lastUsedAt;
    await settled();
    session.push(taskEnded("agent", "completed", "Found it."));
    await settled();
    expect(runtime.lastUsedAt).toBeGreaterThan(before);
    runtime.close();
  });

  test("a background shell is not one: it does not hold the session open", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(taskStarted("shell", "local_bash"));
    session.push(result("Started the server."));
    await turn;

    expect(runtime.hasLiveAgents).toBe(false);
    runtime.close();
  });
});

describe("the result Claude Code emits for its own task notification", () => {
  test("does not end the prompt's turn: a resumed session reports orphaned tasks first", async () => {
    const runtime = start();
    const turn = runtime.runTurn(request("turn-1"));
    session.push(system({ subtype: "task_notification", task_id: "orphan", status: "stopped", output_file: "/tmp/out", summary: "Background agent didn't finish before the previous session ended" }));
    session.push(result("", { num_turns: 0, origin: { kind: "task-notification" } }));
    await settled();
    expect(runtime.busy).toBe(true);

    session.push(assistant("m1", "Picking it back up."));
    session.push(result("Picking it back up."));
    expect(await turn).toBe("Picking it back up.");
    runtime.close();
  });

  test("still ends a turn it started itself", async () => {
    const runtime = start();
    const wakes: Promise<string>[] = [];
    runtime.onWake = (_request, done) => wakes.push(done);
    const turn = runtime.runTurn(request("turn-1"));
    session.push(result("Launched."));
    await turn;

    session.push(assistant("m1", "The agent is done."));
    session.push(result("The agent is done.", { num_turns: 1, origin: { kind: "task-notification", producer: "session-task" } }));
    await settled();
    expect(wakes).toHaveLength(1);
    expect(await wakes[0]).toBe("The agent is done.");
    expect(runtime.busy).toBe(false);
    runtime.close();
  });
});
