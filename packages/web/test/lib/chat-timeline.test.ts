import { describe, expect, it } from "vitest";
import type { ChatItem } from "@chomp/shared";
import {
  buildTimeline,
  liveTurnId,
  maxSeq,
  parseUnifiedDiff,
  pinnedTodos,
  summarizeWork,
  upsertItems,
  type TimelineMessage,
  type WorkItem,
} from "../../src/lib/chat-timeline";

const base = { conversationId: "c1", turnId: "t1", updatedAt: "2026-11-03T10:00:00Z" };

function at(second: number): string {
  return `2026-11-03T10:00:${String(second).padStart(2, "0")}Z`;
}

function text(id: string, seq: number, second: number, body: string, turnId = "t1"): ChatItem {
  return { ...base, turnId, id, seq, createdAt: at(second), kind: "assistant_text", text: body, streaming: false };
}

function tool(id: string, seq: number, second: number, extra: Partial<WorkItem> = {}): ChatItem {
  return {
    ...base, id, seq, createdAt: at(second),
    kind: "tool_call", tool: "Read", title: `Read ${id}`, status: "completed",
    ...extra,
  } as ChatItem;
}

function command(id: string, seq: number, second: number): ChatItem {
  return { ...base, id, seq, createdAt: at(second), kind: "command", command: "ls", output: "", exitCode: 0, status: "completed" };
}

function message(role: TimelineMessage["role"], content: string, second: number, turnId?: string): TimelineMessage {
  return { role, content, createdAt: at(second), turnId };
}

describe("subagents in the timeline", () => {
  it("leaves a subagent and its tool calls to the info panel", () => {
    const subagent = {
      ...base, id: "s1", seq: 2, createdAt: at(2),
      kind: "subagent", name: "Explore", description: "Look", status: "running", toolUses: 1, tokens: 10, durationMs: 1000,
    } as ChatItem;
    const entries = buildTimeline([], [tool("task", 1, 1, { tool: "Agent" }), subagent, tool("inner", 3, 3, { parentId: "s1" } as Partial<WorkItem>)]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "work", items: [{ id: "task" }] });
  });
});

describe("upsertItems", () => {
  it("replaces an item by id and keeps seq order", () => {
    const first = [tool("a", 1, 1, { status: "running" }), tool("b", 2, 2)];
    const next = upsertItems(first, [tool("a", 3, 1, { status: "completed" })]);
    expect(next.map((i) => i.id)).toEqual(["b", "a"]);
    expect(next.find((i) => i.id === "a")).toMatchObject({ status: "completed", seq: 3 });
  });

  it("ignores an older copy of an item it already has", () => {
    const current = [tool("a", 5, 1, { status: "completed" })];
    expect(upsertItems(current, [tool("a", 2, 1, { status: "running" })])).toBe(current);
  });

  it("tracks the highest seq", () => {
    expect(maxSeq([tool("a", 4, 1), tool("b", 9, 2)])).toBe(9);
    expect(maxSeq([])).toBe(0);
  });
});

describe("buildTimeline", () => {
  it("merges messages and items by createdAt, message first on a tie", () => {
    const entries = buildTimeline(
      [message("user", "hi", 1), message("assistant", "bye", 9)],
      [text("x", 1, 1, "thinking aloud"), tool("y", 2, 5)],
    );
    expect(entries.map((e) => e.type)).toEqual(["message", "item", "work", "message"]);
  });

  it("shows only the footer of an assistant message an item of its turn already shows", () => {
    const entries = buildTimeline(
      [message("assistant", "  Done.  ", 9, "t1")],
      [text("x", 1, 5, "Done.")],
    );
    expect(entries.map((e) => e.type)).toEqual(["item", "footer"]);
  });

  it("keeps messages without a turn id, or from another turn, or with other text", () => {
    const entries = buildTimeline(
      [message("assistant", "Done.", 7), message("assistant", "Done.", 8, "t2"), message("assistant", "Other", 9, "t1")],
      [text("x", 1, 5, "Done.")],
    );
    expect(entries.filter((e) => e.type === "message")).toHaveLength(3);
  });

  it("groups consecutive work items of one turn and drops reply tool rows", () => {
    const entries = buildTimeline([], [
      tool("a", 1, 1),
      tool("r", 2, 2, { tool: "mcp__chomp-api__reply" }),
      command("b", 3, 3),
      text("t", 4, 4, "middle"),
      tool("c", 5, 5),
    ]);
    expect(entries.map((e) => e.type)).toEqual(["work", "item", "work"]);
    const first = entries[0];
    expect(first.type === "work" && first.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("splits work groups across turns", () => {
    const entries = buildTimeline([], [tool("a", 1, 1), { ...tool("b", 2, 2), turnId: "t2" } as ChatItem]);
    expect(entries).toHaveLength(2);
  });

  it("marks a group live while its turn runs or an item is running", () => {
    const items = [tool("a", 1, 1)];
    expect(buildTimeline([], items, "t1")[0]).toMatchObject({ live: true });
    expect(buildTimeline([], items)[0]).toMatchObject({ live: false });
    expect(buildTimeline([], [tool("a", 1, 1, { status: "running" })])[0]).toMatchObject({ live: true });
  });

  it("finds the live turn only while a request is open", () => {
    const items = [tool("a", 1, 1), { ...tool("b", 2, 2), turnId: "t2" } as ChatItem];
    expect(liveTurnId(items, true)).toBe("t2");
    expect(liveTurnId(items, false)).toBeUndefined();
  });
});

describe("summarizeWork", () => {
  it("counts tools, commands and distinct files", () => {
    const fileChange = {
      ...base, id: "f", seq: 3, createdAt: at(3), kind: "file_change", status: "completed",
      files: [
        { path: "a.ts", kind: "update", diff: "", additions: 1, deletions: 0 },
        { path: "b.ts", kind: "add", diff: "", additions: 2, deletions: 0 },
      ],
    } as WorkItem;
    expect(summarizeWork([tool("a", 1, 1), tool("b", 2, 2), command("c", 3, 3), fileChange] as WorkItem[]))
      .toBe("Used 2 tools, ran 1 command, changed 2 files");
    expect(summarizeWork([command("c", 3, 3)] as WorkItem[])).toBe("Ran 1 command");
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers lines from the hunk header", () => {
    const lines = parseUnifiedDiff("@@ -10,3 +10,3 @@ fn\n keep\n-old\n+new\n\\ No newline at end of file\n");
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ fn" },
      { kind: "context", text: "keep", oldLine: 10, newLine: 10 },
      { kind: "del", text: "old", oldLine: 11 },
      { kind: "add", text: "new", newLine: 11 },
      { kind: "meta", text: "\\ No newline at end of file" },
    ]);
  });

  it("counts from line 1 without a hunk header", () => {
    expect(parseUnifiedDiff("+a\n+b")).toEqual([
      { kind: "add", text: "a", newLine: 1 },
      { kind: "add", text: "b", newLine: 2 },
    ]);
  });
});

describe("the pinned task list", () => {
  const todos = (id: string, seq: number, second: number, statuses: ("pending" | "in_progress" | "completed")[], turnId = "t1"): ChatItem =>
    ({ ...base, turnId, id, seq, createdAt: at(second), kind: "todo_list", todos: statuses.map((status, i) => ({ text: `step ${i}`, status })) }) as ChatItem;

  it("leaves the timeline and shows the latest list while the turn runs or a task is open", () => {
    const items = [todos("a", 1, 1, ["completed", "pending"]), text("x", 2, 2, "hi"), todos("b", 3, 3, ["completed", "completed"], "t2")];
    expect(buildTimeline([], items).some((entry) => entry.type === "item" && entry.item.kind === "todo_list")).toBe(false);
    expect(pinnedTodos(items, true)?.id).toBe("b");
    expect(pinnedTodos(items, false)).toBeUndefined(); // all done and nothing running: gone
    expect(pinnedTodos(items.slice(0, 2), false)?.id).toBe("a"); // a stopped plan stays in view
  });
});
