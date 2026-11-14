import { expect, test, vi } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { chatItems, conversations } from "../../src/db/schema.js";
import type { TurnRequest } from "../../src/agents/runtime/types.js";

/** A fake Claude Code: the test pushes what it emits, and sees what the runtime sends it and every interrupt. */
const cli = vi.hoisted(() => {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const sent: SDKUserMessage[] = [];
  let interrupts = 0;
  return {
    sent,
    interrupts: () => interrupts,
    push(message: unknown) { queue.push(message); wake?.(); },
    query({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) {
      void (async () => { for await (const message of prompt) sent.push(message); })();
      async function* messages() {
        for (;;) {
          while (queue.length) yield queue.shift();
          await new Promise<void>((resolve) => (wake = resolve));
        }
      }
      return Object.assign(messages(), {
        interrupt: async () => { interrupts++; },
        close: () => {}, setModel: async () => {}, applyFlagSettings: async () => {}, setPermissionMode: async () => {},
        getContextUsage: () => Promise.reject(new Error("not in tests")),
      });
    },
  };
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: cli.query }));

const { ClaudeRuntime } = await import("../../src/agents/runtime/claude.js");

const CONV = "hurry-test-conv";
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const assistant = (id: string, uuids: string[]) =>
  ({ type: "assistant", uuid: `${id}-uuid`, session_id: "s", parent_tool_use_id: null, user_message_uuids: uuids, message: { id, content: [{ type: "text", text: id }] } }) as unknown as SDKMessage;
const result = (subtype: string, uuids: string[], text = "") =>
  ({ type: "result", subtype, result: text, errors: [], user_message_uuids: uuids }) as unknown as SDKMessage;

test("Send now interrupts the step a steer waits on, and the turn goes on to answer the steer", async () => {
  db.insert(conversations).values({ id: CONV, createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z" }).onConflictDoNothing().run();
  const events: { type: string }[] = [];
  const request: TurnRequest = { sessionId: "turn-1", conversationId: CONV, agentName: "Claude Code", prompt: "run the tests", access: "full", cwd: "/tmp", ctx: { conversationId: CONV, send: (payload) => events.push(payload as { type: string }) } };
  const runtime = ClaudeRuntime.start(CONV, request);
  const turn = runtime.runTurn(request);
  await flush();
  const promptUuid = cli.sent[0].uuid!;

  cli.push(assistant("m1", [promptUuid])); // the model starts on the prompt and runs a long tool
  await flush();
  expect(await runtime.steer("stop, do this instead")).toBe(true);
  await flush();
  const steer = cli.sent[1];
  expect(steer.priority).toBe("next"); // `now` would stop an interrupt from killing the tool

  expect(await runtime.hurry()).toBe(true);
  expect(cli.interrupts()).toBe(1);
  cli.push(result("error_during_execution", [promptUuid])); // the interrupted step ends...
  await flush();
  expect(runtime.busy).toBe(true); // ...but the turn does not

  cli.push(assistant("m2", [promptUuid, steer.uuid!])); // the model takes the steer in
  await flush();
  expect(events.filter((e) => e.type === "steers_taken")).toHaveLength(1);
  expect(await runtime.hurry()).toBe(false); // nothing waits now, so nothing gets interrupted
  expect(cli.interrupts()).toBe(1);

  cli.push(result("success", [steer.uuid!], "Done instead."));
  expect(await turn).toBe("Done instead.");
  runtime.close();
});

test("task tools become one live checklist for the turn, not a row per call", async () => {
  const conv = "tasks-test-conv";
  db.insert(conversations).values({ id: conv, createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z" }).onConflictDoNothing().run();
  const request: TurnRequest = { sessionId: "turn-tasks", conversationId: conv, agentName: "Claude Code", prompt: "plan it", access: "full", cwd: "/tmp", ctx: { conversationId: conv, send: () => {} } };
  const runtime = ClaudeRuntime.start(conv, request);
  const turn = runtime.runTurn(request);
  await flush();
  const use = (id: string, name: string, input: object) =>
    ({ type: "assistant", uuid: `${id}-u`, session_id: "s", parent_tool_use_id: null, message: { id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }] } }) as unknown as SDKMessage;
  const created = (id: string, taskId: string) =>
    ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Task #${taskId} created successfully` }] }, tool_use_result: { task: { id: taskId } } }) as unknown as SDKMessage;

  // Streamed first, as Chomp runs Claude Code with partial messages: the block start must not open a row either.
  cli.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg-t1" } } });
  cli.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "TaskCreate", input: {} } } });
  cli.push(use("t1", "TaskCreate", { subject: "Read docs", activeForm: "Reading docs" }));
  cli.push(created("t1", "1"));
  cli.push(use("t2", "TaskCreate", { subject: "Build it" }));
  cli.push(created("t2", "2"));
  cli.push(use("t3", "TaskUpdate", { taskId: "1", status: "completed" }));
  cli.push(use("t4", "TaskUpdate", { taskId: "2", status: "in_progress" }));
  cli.push(result("success", [cli.sent.at(-1)!.uuid!], "Planned."));
  expect(await turn).toBe("Planned.");

  const items = db.select().from(chatItems).where(eq(chatItems.turnId, "turn-tasks")).all();
  expect(items.map((item) => item.kind)).toEqual(["todo_list"]);
  expect(JSON.parse(items[0].payload).todos).toEqual([
    { id: "1", text: "Read docs", status: "completed" },
    { id: "2", text: "Build it", status: "in_progress" },
  ]);
  runtime.close();
});
