import { describe, expect, it } from "vitest";
import type { ChatItem, SubagentStatus } from "@chomp/shared";
import { subagentLine, subagents } from "../../src/lib/subagents";

const base = { conversationId: "c1", turnId: "t1", updatedAt: "2026-11-03T10:00:00Z", createdAt: "2026-11-03T10:00:00Z" };

function subagent(id: string, seq: number, status: SubagentStatus): ChatItem {
  return { ...base, id, seq, kind: "subagent", name: "Explore", description: `Task ${id}`, status, toolUses: 14, tokens: 1000, durationMs: 80_000, lastActivity: "Grep" };
}

function call(id: string, seq: number, parentId: string): ChatItem {
  return { ...base, id, seq, parentId, kind: "tool_call", tool: "Grep", title: `Grep ${id}`, status: "completed" };
}

describe("subagents", () => {
  it("lists running subagents first, each with its own tool calls in order", () => {
    const rows = subagents([subagent("a", 1, "completed"), call("a1", 2, "a"), subagent("b", 3, "running"), call("b1", 4, "b"), call("a2", 5, "a"), call("main", 6, "")]);
    expect(rows.map((row) => row.subagent.id)).toEqual(["b", "a"]);
    expect(rows[1].calls.map((item) => item.id)).toEqual(["a1", "a2"]);
  });

  it("says what a running subagent is doing in one line", () => {
    expect(subagentLine(subagent("a", 1, "running") as Extract<ChatItem, { kind: "subagent" }>)).toBe("Grep · 14 tools · 1m 20s");
    expect(subagentLine({ ...(subagent("a", 1, "running") as Extract<ChatItem, { kind: "subagent" }>), durationMs: 0, toolUses: 1 })).toBe("Grep · 1 tool");
  });
});
