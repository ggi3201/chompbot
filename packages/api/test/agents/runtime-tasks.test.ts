import { beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../../src/db/index.js";
import { chatItems, conversations } from "../../src/db/schema.js";
import type { TurnRequest } from "../../src/agents/runtime/types.js";

/** The SDK's live session, fed by the test; `stop` is the Stop hook the runtime registered. */
const sdk = vi.hoisted(() => {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    stop: null as unknown,
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
  query: ({ options }: { options: { hooks: { Stop: { hooks: unknown[] }[] } } }) => {
    sdk.stop = options.hooks.Stop[0].hooks[0];
    return Object.assign(sdk.messages(), {
      interrupt: async () => {},
      close: () => {},
      getContextUsage: () => Promise.reject(new Error("not in tests")),
    });
  },
}));

const { ClaudeRuntime } = await import("../../src/agents/runtime/claude.js");

const CONV = "tasks-test-conv";
const NOW = "2026-11-10T12:00:00.000Z";
let turnCount = 0;

function request(): TurnRequest {
  return { sessionId: `tasks-turn-${++turnCount}`, conversationId: CONV, agentName: "Claude Code", prompt: "ship it", access: "full", cwd: "/tmp", ctx: { conversationId: CONV, send: () => {} } };
}

const assistant = (id: string, content: object[]) =>
  ({ type: "assistant", uuid: `${id}-uuid`, session_id: "s", parent_tool_use_id: null, message: { id, content } }) as unknown as SDKMessage;
const text = (id: string, value: string) => assistant(id, [{ type: "text", text: value }]);
const taskTool = (id: string, name: string, input: object) => assistant(id, [{ type: "tool_use", id: `tool-${id}`, name, input }]);
const taskCreated = (id: string, taskId: string) =>
  ({ type: "user", session_id: "s", parent_tool_use_id: null, tool_use_result: { task: { id: taskId } }, message: { content: [{ type: "tool_result", tool_use_id: `tool-${id}`, content: "ok" }] } }) as unknown as SDKMessage;
const result = (value: string) => ({ type: "result", subtype: "success", result: value }) as unknown as SDKMessage;

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const stop = (input: object = {}) =>
  (sdk.stop as HookCallback)({ hook_event_name: "Stop", stop_hook_active: false, ...input } as never, undefined, { signal: new AbortController().signal });
const shownTexts = () =>
  db.select().from(chatItems).where(eq(chatItems.conversationId, CONV)).all().map((row) => JSON.parse(row.payload)).filter((body) => body.kind === "assistant_text").map((body) => body.text);
const todos = () =>
  db.select().from(chatItems).where(eq(chatItems.conversationId, CONV)).all().map((row) => JSON.parse(row.payload)).filter((body) => body.kind === "todo_list").at(-1)?.todos;

beforeEach(() => {
  db.insert(conversations).values({ id: CONV, createdAt: NOW, updatedAt: NOW }).onConflictDoNothing().run();
  db.delete(chatItems).where(eq(chatItems.conversationId, CONV)).run();
});

test("a turn ending with an open task goes on once to tidy the list, and its reply stays the answer", async () => {
  const runtime = ClaudeRuntime.start(CONV, request());
  const turn = runtime.runTurn(request());
  sdk.push(taskTool("m1", "TaskCreate", { subject: "Ship it" }));
  sdk.push(taskCreated("m1", "1"));
  sdk.push(taskTool("m2", "TaskUpdate", { taskId: "1", status: "in_progress" }));
  sdk.push(text("m3", "All shipped."));
  await flush();

  const nudge = await stop({ last_assistant_message: "All shipped." });
  expect(nudge).toMatchObject({ decision: "block" });
  expect((nudge as { reason: string }).reason).toContain("#1 [in_progress] Ship it");

  // The agent tidies, and says something anyway.
  sdk.push(taskTool("m4", "TaskUpdate", { taskId: "1", status: "completed" }));
  sdk.push(text("m5", "Task list updated."));
  await flush();
  // It is asked once: Claude Code flags the stop that follows a hook.
  expect(await stop({ stop_hook_active: true, last_assistant_message: "Task list updated." })).toEqual({});
  sdk.push(result("Task list updated."));

  expect(await turn).toBe("All shipped.");
  expect(shownTexts()).toEqual(["All shipped."]);
  expect(todos()).toEqual([{ id: "1", text: "Ship it", status: "completed" }]);

  // Next turn: the list is done, so the turn just ends and its text shows again.
  const next = runtime.runTurn(request());
  sdk.push(text("m6", "Anything else?"));
  await flush();
  expect(await stop({ last_assistant_message: "Anything else?" })).toEqual({});
  sdk.push(result("Anything else?"));
  expect(await next).toBe("Anything else?");
  expect(shownTexts()).toContain("Anything else?");
  runtime.close();
});

test("tasks left pending by an earlier turn do not hold up a turn that never touched the list", async () => {
  const runtime = ClaudeRuntime.start(CONV, request());
  const first = runtime.runTurn(request());
  sdk.push(taskTool("p1", "TaskCreate", { subject: "Wait for the user" }));
  sdk.push(taskCreated("p1", "1"));
  sdk.push(text("p2", "Over to you."));
  await flush();
  expect(await stop({ last_assistant_message: "Over to you." })).toMatchObject({ decision: "block" });
  sdk.push(result(""));
  expect(await first).toBe("Over to you.");

  const second = runtime.runTurn(request());
  sdk.push(text("p3", "It is in Settings."));
  await flush();
  expect(await stop({ last_assistant_message: "It is in Settings." })).toEqual({});
  // Work in the background means the session is only paused.
  expect(await stop({ background_tasks: [{}] })).toEqual({});
  sdk.push(result("It is in Settings."));
  expect(await second).toBe("It is in Settings.");
  runtime.close();
});

test("a runtime started again picks the list up, so an update to an earlier task still lands", async () => {
  const before = ClaudeRuntime.start(CONV, request());
  const first = before.runTurn(request());
  sdk.push(taskTool("r1", "TaskCreate", { subject: "Deploy" }));
  sdk.push(taskCreated("r1", "1"));
  sdk.push(taskTool("r2", "TaskUpdate", { taskId: "1", status: "in_progress" }));
  sdk.push(result("Pushing."));
  await first;
  before.close();

  // Chomp restarted: a new runtime resumes the same Claude Code session.
  const after = ClaudeRuntime.start(CONV, request());
  const second = after.runTurn(request());
  sdk.push(taskTool("r3", "TaskUpdate", { taskId: "1", status: "completed" }));
  sdk.push(result("Deployed."));
  await second;

  expect(todos()).toEqual([{ id: "1", text: "Deploy", status: "completed" }]);
  after.close();
});
