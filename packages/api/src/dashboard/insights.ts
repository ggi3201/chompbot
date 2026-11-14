import { and, count, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentSessions, chatItems, chatMessages, conversations, memories, proactiveRuleRuns, proactiveRules } from "../db/schema.js";
import { getUserTimezone } from "../proactive/engine.js";

export const FAILED_STATUSES = ["failed", "crashed", "timed_out"];

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DURATION_BUCKETS: Array<[label: string, upToSeconds: number]> = [
  ["<10s", 10], ["10–30s", 30], ["30–60s", 60], ["1–2m", 120], ["2–5m", 300], ["5–15m", 900], ["15–30m", 1800], ["30m+", Infinity],
];
const CONTEXT_GROUPS: Record<string, string> = {
  Messages: "Messages",
  "System prompt": "System prompt",
  Skills: "Skills",
  "System tools": "Tools and MCP",
  "MCP tools": "Tools and MCP",
  "MCP server instructions": "Tools and MCP",
  "Memory files": "Memory and custom agents",
  "Custom agents": "Memory and custom agents",
};

export type Insights = ReturnType<typeof buildInsights>;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
const modelFamily = (model: string | null) => /opus/i.test(model ?? "") ? "opus" : /sonnet/i.test(model ?? "") ? "sonnet" : /gpt/i.test(model ?? "") ? "gpt" : "other";

export function buildInsights(now = new Date(), timeZone = getUserTimezone()) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
  const local = (iso: string | Date) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: WEEKDAYS.indexOf(parts.weekday) };
  };
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const today = local(now).day;
  const last30Days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));

  const sessions = db
    .select({ startedAt: agentSessions.startedAt, status: agentSessions.status, durationMs: agentSessions.durationMs, model: agentSessions.model })
    .from(agentSessions)
    .where(ne(agentSessions.status, "running"))
    .all();

  // Runs per day and per week
  const firstCalendarDay = addDays(mondayOf(today), -52 * 7);
  const firstWeek = addDays(mondayOf(today), -25 * 7);
  const weekly = new Map(Array.from({ length: 26 }, (_, i) => [
    addDays(firstWeek, i * 7),
    { week: addDays(firstWeek, i * 7), completed: 0, killed: 0, failed: 0, opus: 0, sonnet: 0, gpt: 0, other: 0 },
  ]));
  const daily: Record<string, number> = {};
  const hoursByDay: Record<string, number> = {};
  const outcomesByDay: Record<string, { completed: number; total: number }> = {};
  for (const session of sessions) {
    const { day } = local(session.startedAt);
    if (day >= firstCalendarDay) daily[day] = (daily[day] ?? 0) + 1;
    hoursByDay[day] = (hoursByDay[day] ?? 0) + (session.durationMs ?? 0) / 3_600_000;
    const outcomes = (outcomesByDay[day] ??= { completed: 0, total: 0 });
    outcomes.total++;
    if (session.status === "completed") outcomes.completed++;
    const week = weekly.get(mondayOf(day));
    if (!week) continue;
    if (session.status === "completed") week.completed++;
    else if (session.status === "killed") week.killed++;
    else week.failed++;
    week[modelFamily(session.model)]++;
  }

  // The user's own messages, by weekday and hour
  const punchcard = WEEKDAYS.map(() => new Array<number>(24).fill(0));
  const messagesByDay: Record<string, number> = {};
  for (const { at } of db.select({ at: chatMessages.createdAt }).from(chatMessages).where(eq(chatMessages.role, "user")).all()) {
    const { day, hour, weekday } = local(at);
    punchcard[weekday][hour]++;
    messagesByDay[day] = (messagesByDay[day] ?? 0) + 1;
  }

  // Tiles
  const since = (days: number) => sessions.filter((s) => s.startedAt >= ago(days));
  const runs30 = since(30);
  const runs7 = since(7);

  // Turn lengths
  const durations = sessions
    .filter((s) => s.status === "completed" && s.durationMs != null && s.startedAt >= ago(90))
    .map((s) => s.durationMs!)
    .sort((a, b) => a - b);
  const durationCounts = DURATION_BUCKETS.map(() => 0);
  for (const ms of durations) durationCounts[DURATION_BUCKETS.findIndex(([, upTo]) => ms / 1000 < upTo)]++;

  // Rules
  const ruleOutcomes = db
    .select({ outcome: proactiveRuleRuns.outcome, count: count() })
    .from(proactiveRuleRuns)
    .where(gte(proactiveRuleRuns.triggeredAt, ago(30)))
    .groupBy(proactiveRuleRuns.outcome)
    .orderBy(desc(count()))
    .all();
  const topRules = db
    .select({ name: proactiveRules.name, count: count() })
    .from(proactiveRuleRuns)
    .innerJoin(proactiveRules, eq(proactiveRules.id, proactiveRuleRuns.ruleId))
    .where(and(gte(proactiveRuleRuns.triggeredAt, ago(30)), eq(proactiveRuleRuns.outcome, "fired")))
    .groupBy(proactiveRules.name)
    .orderBy(desc(count()))
    .limit(7)
    .all();

  // Memories that are still active, cumulative per week
  const memoryWeeks = db
    .select({ at: memories.createdAt })
    .from(memories)
    .where(eq(memories.status, "active"))
    .orderBy(memories.createdAt)
    .all()
    .map((m) => mondayOf(local(m.at).day));
  const memoryGrowth: Array<{ week: string; total: number }> = [];
  for (let week = memoryWeeks[0], i = 0; week && week <= mondayOf(today); week = addDays(week, 7)) {
    while (memoryWeeks[i] === week) i++;
    memoryGrowth.push({ week, total: i });
  }

  // What agents did. chat_items only exists since the runtime rewrite, so the chart says where its data starts.
  const toolsWindow = gte(chatItems.createdAt, ago(30));
  const toolKinds = db.select({ kind: chatItems.kind, count: count(), first: sql<string>`min(${chatItems.createdAt})` }).from(chatItems).where(toolsWindow).groupBy(chatItems.kind).all();
  const toolName = sql<string>`json_extract(${chatItems.payload}, '$.tool')`;
  const toolRows = db.select({ name: toolName, count: count() }).from(chatItems).where(and(toolsWindow, eq(chatItems.kind, "tool_call"))).groupBy(toolName).orderBy(desc(count())).limit(8).all();
  const kindCount = (kind: string) => toolKinds.find((k) => k.kind === kind)?.count ?? 0;
  const tools = [
    { name: "Shell commands", count: kindCount("command") },
    { name: "File edits", count: kindCount("file_change") },
    ...toolRows.map((t) => ({ name: (t.name ?? "unknown").replace(/^mcp__.+?__/, ""), count: t.count })),
  ].sort((a, b) => b.count - a.count).slice(0, 8);

  // Average context per recent conversation, from each one's latest snapshot
  const contextTotals: Record<string, number> = {};
  let contextConversations = 0;
  for (const { usage } of db.select({ usage: conversations.contextUsage }).from(conversations).where(and(isNotNull(conversations.contextUsage), gte(conversations.updatedAt, ago(30)))).all()) {
    try {
      const categories = (JSON.parse(usage!) as { categories?: Array<{ name: string; tokens: number }> }).categories;
      if (!categories?.length) continue;
      contextConversations++;
      for (const { name, tokens } of categories) {
        const group = CONTEXT_GROUPS[name];
        if (group) contextTotals[group] = (contextTotals[group] ?? 0) + tokens;
      }
    } catch {
      // A malformed snapshot only costs this chart one conversation.
    }
  }

  return {
    tiles: {
      runs7: runs7.length,
      runsWeekBefore: since(14).length - runs7.length,
      runs30: runs30.length,
      successRate30: runs30.length ? runs30.filter((s) => s.status === "completed").length / runs30.length : null,
      agentHours7: runs7.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) / 3_600_000,
      messagesYesterday: messagesByDay[last30Days[28]] ?? 0,
      spark: {
        messages: last30Days.map((d) => messagesByDay[d] ?? 0),
        runs: last30Days.map((d) => outcomesByDay[d]?.total ?? 0),
        // Days without runs have no rate, so they are left out rather than drawn as 0%.
        successRate: last30Days.flatMap((d) => (outcomesByDay[d] ? [outcomesByDay[d].completed / outcomesByDay[d].total] : [])),
        agentHours: last30Days.map((d) => hoursByDay[d] ?? 0),
      },
    },
    today,
    daily,
    punchcard,
    weekly: [...weekly.values()],
    durations: {
      labels: DURATION_BUCKETS.map(([label]) => label),
      counts: durationCounts,
      p50: durations[Math.floor(durations.length * 0.5)] ?? 0,
      p90: durations[Math.floor(durations.length * 0.9)] ?? 0,
      total: durations.length,
    },
    rules: { outcomes: ruleOutcomes, top: topRules },
    memoryGrowth,
    tools,
    toolsSince: toolKinds.reduce<string | null>((first, k) => (!first || k.first < first ? k.first : first), null),
    context: {
      conversations: contextConversations,
      groups: Object.entries(contextTotals)
        .map(([name, tokens]) => ({ name, tokens: Math.round(tokens / contextConversations) }))
        .sort((a, b) => b.tokens - a.tokens),
    },
  };
}
