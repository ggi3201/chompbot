import { readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import type { ChatItem } from "@chomp/shared";
import { db } from "../../src/db/index.js";
import { chatItems, chatMessages, conversations } from "../../src/db/schema.js";
import { listChatItems, onChatItem, stopOrphanedSubagents, TurnItems } from "../../src/agents/runtime/items.js";
import { claudeToolItem, DECLINED_MESSAGE, diffFile, splitProposedPlan, withToolResult } from "../../src/agents/runtime/describe.js";
import { codexCollabItems, codexItemBody, codexSubagentNotification } from "../../src/agents/runtime/codex.js";
import { forkConversation } from "../../src/agents/runtime/fork.js";
import { claudeSubagentMessage } from "../../src/agents/runtime/claude.js";

const CONV = "runtime-test-conv";
const NOW = "2026-11-03T12:00:00.000Z";

const broadcast: ChatItem[] = [];
onChatItem((item) => broadcast.push(item));

beforeEach(() => {
  broadcast.length = 0;
  db.insert(conversations).values({ id: CONV, createdAt: NOW, updatedAt: NOW }).onConflictDoNothing().run();
});

afterEach(() => {
  db.delete(chatItems).where(eq(chatItems.conversationId, CONV)).run();
});

describe("TurnItems", () => {
  test("coalesces streamed deltas into one write with the full text", () => {
    const items = new TurnItems(CONV, "turn-1");
    items.appendText("msg:0", "assistant_text", "Hel");
    items.appendText("msg:0", "assistant_text", "lo");
    items.flush();

    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({ id: "turn-1:msg:0", kind: "assistant_text", text: "Hello", streaming: true });
  });

  test("every update takes a new seq, so afterSeq replays only what changed", () => {
    const items = new TurnItems(CONV, "turn-1");
    items.set("tool-1", { kind: "command", command: "ls", output: "", exitCode: null, status: "running" }, { immediate: true });
    items.set("tool-2", { kind: "tool_call", tool: "Read", title: "Read a.ts", status: "running" }, { immediate: true });
    const seen = listChatItems(CONV).at(-1)!.seq;

    items.patch("tool-1", "command", { output: "a.ts", exitCode: 0, status: "completed" }, { immediate: true });

    const replay = listChatItems(CONV, seen);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ id: "turn-1:tool-1", status: "completed", output: "a.ts" });
    expect(listChatItems(CONV)).toHaveLength(2);
  });

  test("a write after the chat was deleted is dropped: from a timer it would take the API down", () => {
    const items = new TurnItems("a-chat-that-was-deleted", "turn-1");
    expect(() => items.set("subagent:1", { kind: "subagent", name: "Explore", description: "Look", status: "running", toolUses: 0, tokens: 0, durationMs: 0 }, { immediate: true })).not.toThrow();
    expect(broadcast).toHaveLength(0);
  });

  test("settle closes what a dead turn left open", () => {
    const items = new TurnItems(CONV, "turn-1");
    items.set("cmd", { kind: "command", command: "make", output: "", exitCode: null, status: "running" });
    items.appendText("msg:0", "assistant_text", "Work");
    items.set("approval:1", { kind: "approval", requestId: "1", title: "Run command", detail: "make", state: "pending" });
    items.set("subagent:1", { kind: "subagent", name: "Explore", description: "Look", status: "running", toolUses: 0, tokens: 0, durationMs: 0 });
    items.settle("completed");

    const byId = Object.fromEntries(listChatItems(CONV).map((item) => [item.id, item]));
    expect(byId["turn-1:cmd"]).toMatchObject({ status: "completed" });
    expect(byId["turn-1:subagent:1"]).toMatchObject({ status: "stopped" });
    expect(byId["turn-1:msg:0"]).toMatchObject({ streaming: false });
    expect(byId["turn-1:approval:1"]).toMatchObject({ state: "expired" });
  });
});

describe("Claude tool mapping", () => {
  test("Edit becomes a diff of its own input", () => {
    const body = claudeToolItem("Edit", { file_path: "/w/a.txt", old_string: "hi\n", new_string: "hello world\n" });
    expect(body).toMatchObject({ kind: "file_change", status: "running" });
    const [file] = (body as Extract<typeof body, { kind: "file_change" }>).files;
    expect(file).toMatchObject({ path: "/w/a.txt", additions: 1, deletions: 1 });
    expect(file.diff).toContain("-hi");
    expect(file.diff).toContain("+hello world");
  });

  test("a result echoing the decline message marks the command declined, not failed", () => {
    const running = claudeToolItem("Bash", { command: "rm -rf build" });
    expect(withToolResult(running, DECLINED_MESSAGE, true)).toMatchObject({ status: "declined" });
    expect(withToolResult(running, "Exit code 2\nnope", true)).toMatchObject({ status: "failed", exitCode: 2 });
  });
});

describe("Claude subagents", () => {
  // A real Explore run, captured from `claude -p --output-format stream-json`.
  const lines = readFileSync(new URL("../fixtures/claude-subagent.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage);
  const SUBAGENT = "turn-1:subagent:toolu_014WLLGmznbf3yGArwWHfXKL";

  test("the task events become one subagent item, and its tool calls point at it", () => {
    const items = new TurnItems(CONV, "turn-1");
    for (const line of lines) expect(claudeSubagentMessage(items, line)).toBe(true);
    items.flush();

    const all = listChatItems(CONV);
    expect(all.find((item) => item.id === SUBAGENT)).toMatchObject({
      kind: "subagent",
      name: "Explore",
      description: "Locate TurnItems class definition",
      status: "completed",
      toolUses: 2,
      tokens: 19767,
      durationMs: 7022,
      lastActivity: "Reading ~/code/chomp-subagents/packages/api/src/agents/runtime/items.ts",
    });
    expect(all.find((item) => item.id === SUBAGENT)).toHaveProperty("summary", expect.stringMatching(/^I couldn't find/));
    const calls = all.filter((item) => item.parentId === SUBAGENT);
    expect(calls.map((item) => item.kind === "tool_call" ? item.tool : item.kind)).toEqual(["command", "Read"]);
    expect(calls.every((item) => "status" in item && item.status !== "running")).toBe(true);
  });

  test("the progress line shows what it is doing while it runs", () => {
    const items = new TurnItems(CONV, "turn-1");
    for (const line of lines.slice(0, 2)) claudeSubagentMessage(items, line);
    items.flush();
    expect(listChatItems(CONV).find((item) => item.id === SUBAGENT)).toMatchObject({ status: "running", toolUses: 1, lastActivity: "Running Locate items.ts and grep for class TurnItems" });
  });

  test("a background shell is a task too, but not a subagent", () => {
    const items = new TurnItems(CONV, "turn-1");
    const shell = { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_shell", description: "Log the work", task_type: "local_bash", uuid: "u", session_id: "s" } as SDKMessage;
    expect(claudeSubagentMessage(items, shell)).toBe(true);
    items.flush();
    expect(listChatItems(CONV)).toHaveLength(0);
  });

  test("main-thread messages are left to the timeline", () => {
    const items = new TurnItems(CONV, "turn-1");
    expect(claudeSubagentMessage(items, { ...lines[3], parent_tool_use_id: null } as SDKMessage)).toBe(false);
  });
});

describe("Codex subagents", () => {
  const collab = (tool: string, status: string, agentsStates: Record<string, { status: string; message: string | null }>) => ({
    type: "collabAgentToolCall",
    id: `call-${tool}`,
    tool,
    status,
    senderThreadId: "main",
    receiverThreadIds: Object.keys(agentsStates),
    prompt: tool === "spawnAgent" ? "Find the auth code\nand report back" : null,
    model: null,
    reasoningEffort: null,
    agentsStates,
  });

  test("the spawn starts a subagent per thread and a later wait reports how it ended", () => {
    const items = new TurnItems(CONV, "turn-1");
    codexCollabItems(items, collab("spawnAgent", "completed", { t1: { status: "pendingInit", message: null } }));
    items.flush();
    expect(listChatItems(CONV)).toMatchObject([{ id: "turn-1:subagent:t1", kind: "subagent", name: "Agent", description: "Find the auth code", status: "running" }]);

    codexCollabItems(items, collab("wait", "completed", { t1: { status: "completed", message: "Auth lives in src/auth." } }));
    items.flush();
    expect(listChatItems(CONV).at(-1)).toMatchObject({ id: "turn-1:subagent:t1", status: "completed", summary: "Auth lives in src/auth." });
  });

  // A real run with Codex's stable multi_agent feature, from Chomp's own log of the app-server.
  const notifications = readFileSync(new URL("../fixtures/codex-subagent.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  const MAIN = "00000000-0000-4000-8000-000000000001";
  const CHILD = "turn-1:subagent:00000000-0000-4000-8000-000000000003";

  test("subAgentActivity becomes a subagent, and the child thread's work goes under it", () => {
    const items = new TurnItems(CONV, "turn-1");
    const handled = notifications.map(({ method, params }) => codexSubagentNotification(items, MAIN, method, params));
    items.flush();

    const all = listChatItems(CONV);
    expect(all.find((item) => item.id === CHILD)).toMatchObject({
      kind: "subagent",
      name: "Agent",
      description: "find turnitems",
      status: "completed",
      toolUses: 1,
      tokens: 55462,
      summary: expect.stringContaining("packages/api/src/agents/runtime/items.ts"),
    });
    const calls = all.filter((item) => item.parentId === CHILD);
    expect(calls).toMatchObject([{ kind: "command", status: "completed" }]);
    // The child's messages and its turn never reach the main timeline.
    expect(all.filter((item) => !item.parentId && item.kind !== "subagent")).toHaveLength(0);
    const mainTurn = notifications.findIndex(({ method, params }) => method === "turn/completed" && params.threadId === MAIN);
    expect(handled[mainTurn]).toBe(false);
  });

  test("a wait on an agent this turn did not spawn adds nothing", () => {
    const items = new TurnItems(CONV, "turn-1");
    codexCollabItems(items, collab("wait", "completed", { t9: { status: "running", message: null } }));
    items.flush();
    expect(listChatItems(CONV)).toHaveLength(0);
  });
});

describe("Fork", () => {
  test("a subagent's tool calls still point at it in the fork", async () => {
    db.insert(chatMessages).values({ id: "fork-msg", conversationId: CONV, role: "user", content: "go", createdAt: "2999-01-01T00:00:00.000Z" }).onConflictDoNothing().run();
    const items = new TurnItems(CONV, "turn-1");
    items.set("subagent:a", { kind: "subagent", name: "Explore", description: "Look", status: "completed", toolUses: 1, tokens: 1, durationMs: 1 });
    items.set("read-1", { kind: "tool_call", tool: "Read", title: "Read a.ts", status: "completed" }, { parentId: "subagent:a", immediate: true });

    const { id } = await forkConversation(CONV, "fork-msg");
    const forked = listChatItems(id);
    const subagent = forked.find((item) => item.kind === "subagent")!;
    expect(forked.find((item) => item.kind === "tool_call")?.parentId).toBe(subagent.id);
  });

  test("a subagent still running in the source is stopped in the fork, which has no session to finish it", async () => {
    db.insert(chatMessages).values({ id: "fork-msg-2", conversationId: CONV, role: "user", content: "go", createdAt: "2999-01-01T00:00:00.000Z" }).onConflictDoNothing().run();
    const items = new TurnItems(CONV, "turn-1");
    items.set("subagent:a", { kind: "subagent", name: "Explore", description: "Look", status: "running", toolUses: 1, tokens: 1, durationMs: 1 }, { immediate: true });

    const { id } = await forkConversation(CONV, "fork-msg-2");
    expect(listChatItems(id).find((item) => item.kind === "subagent")).toMatchObject({ status: "stopped" });
    expect(listChatItems(CONV).find((item) => item.kind === "subagent")).toMatchObject({ status: "running" });
  });
});

describe("After a crash", () => {
  test("subagent rows left running are stopped at startup, with a new seq so clients see it", () => {
    const items = new TurnItems(CONV, "turn-1");
    items.set("subagent:a", { kind: "subagent", name: "Explore", description: "Look", status: "running", toolUses: 1, tokens: 1, durationMs: 1 }, { immediate: true });
    items.set("subagent:b", { kind: "subagent", name: "Explore", description: "Look", status: "completed", toolUses: 1, tokens: 1, durationMs: 1 }, { immediate: true });
    const seen = listChatItems(CONV).at(-1)!.seq;

    stopOrphanedSubagents();

    expect(listChatItems(CONV, seen)).toMatchObject([{ id: "turn-1:subagent:a", status: "stopped" }]);
    expect(listChatItems(CONV).find((item) => item.id === "turn-1:subagent:b")).toMatchObject({ status: "completed" });
  });
});

describe("Codex item mapping", () => {
  test("an added file arrives as plain content and still gets a diff with counts", () => {
    const body = codexItemBody({
      type: "fileChange",
      id: "fc-1",
      status: "completed",
      changes: [{ path: "/w/new.txt", kind: { type: "add" }, diff: "line one\nline two\n" }],
    });
    expect(body).toMatchObject({ kind: "file_change", status: "completed", files: [{ path: "/w/new.txt", kind: "add", additions: 2, deletions: 0 }] });
  });

  test("an updated file keeps Codex's own unified diff", () => {
    const diff = diffFile("/w/a.txt", "old\n", "new\n", "update").diff;
    const body = codexItemBody({ type: "fileChange", id: "fc-2", status: "completed", changes: [{ path: "/w/a.txt", kind: { type: "update" }, diff }] });
    expect(body).toMatchObject({ files: [{ diff, additions: 1, deletions: 1 }] });
  });
});

describe("Codex plan mode", () => {
  test("the <proposed_plan> block becomes the plan and leaves the rest of the message", () => {
    const message = "Here is the plan.\n\n<proposed_plan>\n# Add notes.md\n\n1. Write the file\n</proposed_plan>";
    expect(splitProposedPlan(message)).toEqual({ text: "Here is the plan.", plan: "# Add notes.md\n\n1. Write the file" });
  });

  test("a message that only mentions the tag is left alone", () => {
    const message = "I will end with a <proposed_plan> block once we agree.";
    expect(splitProposedPlan(message)).toEqual({ text: message });
  });
});
