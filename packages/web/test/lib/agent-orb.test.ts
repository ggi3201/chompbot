import { describe, expect, it } from "vitest";
import type { ChatItem } from "@chomp/shared";
import { orbStateFor } from "../../src/lib/agent-orb";

const item = (body: object) => ({ id: "i", turnId: "t", seq: 1, createdAt: "", ...body }) as unknown as ChatItem;

describe("orbStateFor", () => {
  it("follows the latest running item", () => {
    for (const [name, body, state] of [
      ["thinking", { kind: "reasoning", text: "", streaming: true }, "solving"],
      ["writing", { kind: "assistant_text", text: "", streaming: true }, "composing"],
      ["looking something up", { kind: "tool_call", tool: "WebSearch", status: "running" }, "searching"],
      ["reading a file", { kind: "tool_call", tool: "Read", status: "running" }, "searching"],
      ["using another tool", { kind: "tool_call", tool: "send_imessage", status: "running" }, "working"],
      ["running a command", { kind: "command", command: "ls", status: "running" }, "working"],
      ["editing files", { kind: "file_change", files: [], status: "running" }, "shaping"],
      ["waiting on a subagent", { kind: "subagent", status: "running" }, "weaving"],
    ] as const) {
      expect(orbStateFor("agent_working", item(body)), name).toBe(state);
    }
  });

  it("falls back to the turn's status once the item is finished, or with no item", () => {
    expect(orbStateFor("agent_working", item({ kind: "command", command: "ls", status: "completed" }))).toBe("working");
    expect(orbStateFor("triaging", item({ kind: "reasoning", text: "", streaming: false }))).toBe("connecting");
    for (const [status, state] of [
      ["triaging", "connecting"],
      ["researching", "searching"],
      ["streaming", "composing"],
      ["agent_working", "working"],
      [null, "breathing"],
      [undefined, "breathing"],
      ["something new", "breathing"],
    ] as const) {
      expect(orbStateFor(status, undefined), String(status)).toBe(state);
    }
  });
});
