import { and, asc, gte, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { chatItems, chatMessages, conversations, routingFeedback } from "../../db/schema.js";

/** Stays under Claude Code's MCP output cap, with room to spare. */
const MAX_CHARS = 60_000;
/** A user message that reads as pushback on the turn before it. */
const CORRECTION = /^(no\b|nope|wrong|not what|that'?s not|stop\b|why (did|didn'?t|is|isn'?t)|still\b|again\b|elo\b|doesn'?t work|didn'?t work|broken|you forgot)/i;

interface Failure {
  conversationId: string;
  at: string;
  what: string;
  detail: string;
  key: string;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** The first line of a failed result worth reading: not the "Exit code N" header. */
function firstErrorLine(output: string): string {
  return output.split("\n").map((line) => line.trim()).find((line) => line && !/^Exit code \d+$/.test(line)) ?? "";
}

function failureOf(conversationId: string, at: string, payload: string): Failure | null {
  const body = JSON.parse(payload) as { kind: string; status?: string; exitCode?: number; command?: string; tool?: string; output?: string };
  const failed = body.status === "failed" || (body.kind === "command" && (body.exitCode ?? 0) > 0);
  if (!failed) return null;
  const what = body.kind === "command" ? `$ ${clip(body.command ?? "", 140)}` : `tool ${body.tool}`;
  const detail = clip(firstErrorLine(body.output ?? ""), 160);
  // Silent failures (a grep that matched nothing, a killed sleep) say nothing; group them by what ran.
  const key = detail || `${body.kind === "command" ? clip(body.command ?? "", 40) : body.tool} (exit ${body.exitCode ?? "?"}, no output)`;
  return { conversationId, at, what, detail: detail || "(no error output)", key: signature(key) };
}

/** Same error, different paths/ids/numbers: one signature. */
function signature(text: string): string {
  return text.toLowerCase().replace(/[0-9a-f]{8,}|\d+/g, "#").replace(/\/[\w./-]+/g, "<path>").slice(0, 90);
}

/**
 * What happened in Chomp's chats over the last `days`, compressed for the
 * dream: failures that recur across turns first, then pushback and thumbs-down,
 * then each conversation's turns with their failed commands and tools.
 */
export function execDreamDigest(args: { days?: number }): string {
  const days = Math.min(Math.max(Math.round(args.days ?? 7), 1), 31);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const messages = db.select().from(chatMessages).where(gte(chatMessages.createdAt, since)).orderBy(asc(chatMessages.createdAt)).all();
  const items = db
    .select()
    .from(chatItems)
    .where(and(gte(chatItems.createdAt, since), inArray(chatItems.kind, ["command", "tool_call"])))
    .orderBy(asc(chatItems.createdAt))
    .all();
  const feedback = db.select().from(routingFeedback).where(gte(routingFeedback.createdAt, since)).all().filter((f) => f.feedbackType !== "thumbs_up");
  if (messages.length === 0) return `No chat messages in the last ${days} days.`;

  const failures = items.flatMap((item) => failureOf(item.conversationId, item.createdAt, item.payload) ?? []);
  const groups = new Map<string, Failure[]>();
  for (const failure of failures) groups.set(failure.key, [...(groups.get(failure.key) ?? []), failure]);
  const spread = (group: Failure[]) => [...new Set(group.map((f) => f.conversationId.slice(0, 8)))];
  // Retrying inside one chat is not a pattern; the same failure across chats is.
  const recurring = [...groups.values()].filter((group) => spread(group).length > 1).sort((a, b) => b.length - a.length);

  const corrections = messages.filter((m) => m.role === "user" && CORRECTION.test(m.content.trim()));
  const conversationIds = [...new Set(messages.map((m) => m.conversationId))];
  const titles = new Map(
    db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(inArray(conversations.id, conversationIds)).all().map((c) => [c.id, c.title]),
  );
  const short = (id: string) => id.slice(0, 8);
  const when = (iso: string) => iso.slice(5, 16).replace("T", " ");

  const out: string[] = [
    `# Dream digest: last ${days} days (since ${since.slice(0, 10)})`,
    `${conversationIds.length} conversations, ${messages.filter((m) => m.role === "user").length} user messages, ${failures.length} failed commands/tools, ${corrections.length} pushback messages, ${feedback.length} thumbs-down/corrections.`,
    "",
    "## Recurring failures (same error in 2+ conversations)",
    ...(recurring.length
      ? recurring.map((group) => `- ${group.length}× in ${spread(group).length} conv (${spread(group).join(", ")}): "${group[0].detail}" e.g. ${group[0].what}`)
      : ["- none"]),
    "",
    "## Pushback from the user",
    ...(corrections.length ? corrections.map((m) => `- [${when(m.createdAt)}] ${short(m.conversationId)}: "${clip(m.content, 200)}"`) : ["- none"]),
    ...feedback.map((f) => `- [${when(f.createdAt)}] ${short(f.conversationId)} ${f.feedbackType}: "${clip(f.userMessage ?? "", 160)}"${f.correction ? ` → "${clip(f.correction, 160)}"` : ""}`),
    "",
    "## Conversations",
  ];

  // Scheduled runs that asked nothing and failed nothing carry no signal for the dream.
  const quiet = conversationIds.filter((id) => !messages.some((m) => m.conversationId === id && m.role === "user") && !failures.some((f) => f.conversationId === id));
  if (quiet.length) out.push(`(${quiet.length} proactive runs with no user message and no failure left out: ${[...new Set(quiet.map((id) => titles.get(id) || "untitled"))].join("; ")})`);

  for (const id of conversationIds.filter((id) => !quiet.includes(id))) {
    const timeline = [
      ...messages.filter((m) => m.conversationId === id).map((m) => ({ at: m.createdAt, line: m.role === "user" ? `  [${when(m.createdAt)}] USER: ${clip(m.content, 220)}` : `    ↳ reply: ${clip(m.content, 180)}` })),
      ...failures.filter((f) => f.conversationId === id).map((f) => ({ at: f.at, line: `    ✗ ${f.what} → ${f.detail}` })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    out.push("", `### ${titles.get(id) || "(untitled)"} (${short(id)})`, ...timeline.map((t) => t.line));
  }

  const text = out.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[digest cut at ${MAX_CHARS} chars: call again with fewer days for the rest]` : text;
}
