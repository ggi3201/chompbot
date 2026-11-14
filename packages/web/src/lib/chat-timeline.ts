import type { ChatItem } from "@chomp/shared";

/** The minimum a chat message needs to take part in the timeline. */
export interface TimelineMessage {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  turnId?: string;
}

export type WorkItem = Extract<ChatItem, { kind: "tool_call" | "command" | "file_change" }>;

/** The items the timeline renders one by one. Subagents show in the chat info panel instead. */
export type TimelineItem = Exclude<ChatItem, WorkItem | { kind: "subagent" }>;

export type TimelineEntry<M extends TimelineMessage> =
  | { type: "message"; message: M }
  /** A reply whose text an item already shows: only its time and actions (copy, fork) remain. */
  | { type: "footer"; message: M }
  | { type: "item"; item: TimelineItem }
  | { type: "work"; id: string; turnId: string; items: WorkItem[]; live: boolean };

/** Its text already reaches the chat as a message, so a row for it would say the same thing twice. */
const REPLY_TOOL = "mcp__chomp-api__reply";

const WORK_KINDS = new Set<ChatItem["kind"]>(["tool_call", "command", "file_change"]);

export function isWorkItem(item: ChatItem): item is WorkItem {
  return WORK_KINDS.has(item.kind);
}

function isRunning(item: WorkItem): boolean {
  return item.status === "running";
}

/**
 * Upserts by id. An update replaces the whole item, but never with an older
 * `seq`: a REST load that started before a live update must not undo it.
 * The result stays in `seq` order.
 */
export function upsertItems(prev: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((item) => [item.id, item]));
  let changed = false;
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (existing && existing.seq > item.seq) continue;
    byId.set(item.id, item);
    changed = true;
  }
  if (!changed) return prev;
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function maxSeq(items: ChatItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.seq), 0);
}

/** The turn the agent is working on now: the newest turn, while a request is open. */
export function liveTurnId(items: ChatItem[], isTurnActive: boolean): string | undefined {
  if (!isTurnActive || items.length === 0) return undefined;
  return items[items.length - 1].turnId;
}

/**
 * An assistant message is hidden when an `assistant_text` item of the same
 * turn already shows the same text. Messages without a turn id always show.
 */
function hiddenByItems(message: TimelineMessage, textsByTurn: Map<string, Set<string>>): boolean {
  if (message.role !== "assistant" || !message.turnId) return false;
  return textsByTurn.get(message.turnId)?.has(message.content.trim()) ?? false;
}

/** The agent's latest task list, while its turn runs or a task is still open; it sits above the composer like Claude Code's. */
export function pinnedTodos(items: ChatItem[], turnActive: boolean): Extract<ChatItem, { kind: "todo_list" }> | undefined {
  const latest = items
    .filter((item): item is Extract<ChatItem, { kind: "todo_list" }> => item.kind === "todo_list")
    .sort((a, b) => timeOf(a) - timeOf(b) || a.seq - b.seq)
    .at(-1);
  return latest && (turnActive || latest.todos.some((todo) => todo.status !== "completed")) ? latest : undefined;
}

function timeOf(value: { createdAt?: string }): number {
  return value.createdAt ? new Date(value.createdAt).getTime() : Number.NEGATIVE_INFINITY;
}

/**
 * Merges messages and agent items into one list by `createdAt`, hides the
 * duplicates, and folds consecutive work items of one turn into a group.
 * Both inputs keep their own order; on a tie the message goes first, so a
 * user message stays above the work it started.
 */
export function buildTimeline<M extends TimelineMessage>(
  messages: M[],
  items: ChatItem[],
  liveTurn?: string,
): TimelineEntry<M>[] {
  const textsByTurn = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.kind !== "assistant_text") continue;
    const texts = textsByTurn.get(item.turnId) ?? new Set<string>();
    texts.add(item.text.trim());
    textsByTurn.set(item.turnId, texts);
  }


  const visibleItems = items
    // The task list is pinned above the composer instead (pinnedTodos).
    .filter((item): item is TimelineItem | WorkItem => !item.parentId && item.kind !== "subagent" && item.kind !== "todo_list")
    .filter((item) => !(item.kind === "tool_call" && item.tool === REPLY_TOOL))
    .sort((a, b) => timeOf(a) - timeOf(b) || a.seq - b.seq);

  const entries: TimelineEntry<M>[] = [];
  const pushItem = (item: TimelineItem | WorkItem) => {
    if (!isWorkItem(item)) {
      entries.push({ type: "item", item });
      return;
    }
    const last = entries[entries.length - 1];
    if (last?.type === "work" && last.turnId === item.turnId) {
      last.items.push(item);
      last.live ||= isRunning(item);
      return;
    }
    entries.push({
      type: "work",
      id: item.id,
      turnId: item.turnId,
      items: [item],
      live: item.turnId === liveTurn || isRunning(item),
    });
  };

  let m = 0;
  let i = 0;
  while (m < messages.length || i < visibleItems.length) {
    const message = messages[m];
    const item = visibleItems[i];
    if (message && (!item || timeOf(message) <= timeOf(item))) {
      entries.push({ type: hiddenByItems(message, textsByTurn) ? "footer" : "message", message });
      m++;
    } else {
      pushItem(item);
      i++;
    }
  }
  return entries;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Used 2 tools, ran 1 command, changed 3 files" — the collapsed work group's line. */
export function summarizeWork(items: WorkItem[]): string {
  const tools = items.filter((item) => item.kind === "tool_call").length;
  const commands = items.filter((item) => item.kind === "command").length;
  const files = new Set(
    items.flatMap((item) => (item.kind === "file_change" ? item.files.map((f) => f.path) : [])),
  ).size;
  const parts = [
    tools > 0 && `used ${plural(tools, "tool", "tools")}`,
    commands > 0 && `ran ${plural(commands, "command", "commands")}`,
    files > 0 && `changed ${plural(files, "file", "files")}`,
  ].filter((part): part is string => !!part);
  const text = parts.join(", ") || "worked";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "context" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses unified diff hunks into lines with old/new line numbers. Text without a hunk header counts from line 1. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const raw = diff.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();

  let oldLine = 1;
  let newLine = 1;
  return raw.map((line): DiffLine => {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      return { kind: "hunk", text: line };
    }
    if (line.startsWith("\\")) return { kind: "meta", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line.slice(1), newLine: newLine++ };
    if (line.startsWith("-")) return { kind: "del", text: line.slice(1), oldLine: oldLine++ };
    return { kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ };
  });
}
