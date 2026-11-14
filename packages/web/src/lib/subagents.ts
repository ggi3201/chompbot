import type { ChatItem } from "@chomp/shared";
import { formatElapsed } from "./format";
import { isWorkItem, type WorkItem } from "./chat-timeline";

export type SubagentItem = Extract<ChatItem, { kind: "subagent" }>;

export interface SubagentRow {
  subagent: SubagentItem;
  /** Its own tool calls, commands and edits, oldest first. */
  calls: WorkItem[];
}

/** The chat's subagents, running ones first, each with the work it did. */
export function subagents(items: ChatItem[]): SubagentRow[] {
  const rows = new Map<string, SubagentRow>();
  for (const item of items) {
    if (item.kind === "subagent") rows.set(item.id, { subagent: item, calls: rows.get(item.id)?.calls ?? [] });
  }
  for (const item of items) {
    if (item.parentId && isWorkItem(item)) rows.get(item.parentId)?.calls.push(item);
  }
  const running = (row: SubagentRow) => (row.subagent.status === "running" ? 0 : 1);
  return [...rows.values()].sort((a, b) => running(a) - running(b));
}

/** "Grep · 14 tools · 1m 20s". Codex reports no duration, so it has none. */
export function subagentLine(subagent: SubagentItem): string {
  const tools = `${subagent.toolUses} ${subagent.toolUses === 1 ? "tool" : "tools"}`;
  const duration = subagent.durationMs > 0 && formatElapsed(Math.round(subagent.durationMs / 1000));
  return [subagent.lastActivity, tools, duration].filter(Boolean).join(" · ");
}
