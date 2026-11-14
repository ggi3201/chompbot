import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { activityLog, agentSessions, chatItems, chatMessages, mcpServers, memories, proactiveRuleRuns, schedules, souls } from "../db/schema.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { buildInsights, FAILED_STATUSES, type Insights } from "../dashboard/insights.js";

const router: ReturnType<typeof Router> = Router();

// Activity log with pagination
router.get("/activity", (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
  const offset = parseInt((req.query.offset as string) ?? "0", 10);

  const result = db
    .select()
    .from(activityLog)
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const parsed = result.map((entry) => ({
    ...entry,
    details: entry.details ? JSON.parse(entry.details) : null,
  }));

  res.json(parsed);
});

// Quick stats
router.get("/stats", (_req: Request, res: Response) => {
  const allSouls = db.select().from(souls).all();
  const allSchedules = db.select().from(schedules).all();
  const allMcpServers = db.select().from(mcpServers).all();

  const memoryCount = db.select().from(memories).all().length;

  // Messages today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();
  const messagesToday = db
    .select()
    .from(chatMessages)
    .where(gte(chatMessages.createdAt, todayStr))
    .all()
    .filter((m) => m.role === "user").length;

  const recentActivity = db
    .select()
    .from(activityLog)
    .orderBy(desc(activityLog.createdAt))
    .limit(5)
    .all();

  res.json({
    agents: { total: allSouls.length },
    schedules: { total: allSchedules.length, enabled: allSchedules.filter((s) => s.enabled).length },
    mcpServers: { total: allMcpServers.length, enabled: allMcpServers.filter((s) => s.enabled).length },
    memories: memoryCount,
    messagesToday,
    recentActivity: recentActivity.map((a) => ({
      ...a,
      details: a.details ? JSON.parse(a.details) : null,
    })),
  });
});

const HOUR = 60 * 60 * 1000;
const RANGES = new Map([
  ["24h", { buckets: 24, size: HOUR }],
  ["7d", { buckets: 28, size: 6 * HOUR }],
  ["30d", { buckets: 30, size: 24 * HOUR }],
]);

// Counts per bucket, oldest first, for the dashboard's main chart.
router.get("/timeseries", (req: Request, res: Response) => {
  const { buckets, size } = RANGES.get(String(req.query.range)) ?? RANGES.get("24h")!;
  // shortcut: 7d and 30d buckets count back from the next whole hour, not from midnight. Align them if a day label ever misleads.
  const end = Math.ceil(Date.now() / HOUR) * HOUR;
  const start = end - buckets * size;
  const cutoff = new Date(start).toISOString();

  const bucketed = (times: string[]) => {
    const counts: number[] = new Array(buckets).fill(0);
    for (const time of times) {
      const age = Math.floor((end - Date.parse(time)) / size);
      if (age >= 0 && age < buckets) counts[buckets - 1 - age]++;
    }
    return counts;
  };

  const messages = db.select({ at: chatMessages.createdAt }).from(chatMessages).where(gte(chatMessages.createdAt, cutoff)).all().map((r) => r.at);
  const activity = db.select({ at: activityLog.createdAt, type: activityLog.type }).from(activityLog).where(gte(activityLog.createdAt, cutoff)).all();
  const toolCalls = db
    .select({ at: chatItems.createdAt })
    .from(chatItems)
    .where(and(gte(chatItems.createdAt, cutoff), inArray(chatItems.kind, ["tool_call", "command", "file_change"])))
    .all();
  const ruleFires = db
    .select({ at: proactiveRuleRuns.triggeredAt })
    .from(proactiveRuleRuns)
    .where(and(gte(proactiveRuleRuns.triggeredAt, cutoff), eq(proactiveRuleRuns.outcome, "fired")))
    .all();
  const failedRuns = db
    .select({ at: agentSessions.startedAt })
    .from(agentSessions)
    .where(and(gte(agentSessions.startedAt, cutoff), inArray(agentSessions.status, FAILED_STATUSES)))
    .all();

  res.json({
    messages: bucketed(messages),
    activity: bucketed(activity.map((a) => a.at)),
    toolCalls: bucketed(toolCalls.map((r) => r.at)),
    ruleFires: bucketed(ruleFires.map((r) => r.at)),
    memoriesSaved: bucketed(activity.filter((a) => a.type === "memory.saved").map((a) => a.at)),
    failedRuns: bucketed(failedRuns.map((r) => r.at)),
    hours: Array.from({ length: buckets }, (_, i) => new Date(start + i * size).toISOString()),
    totalMessages: messages.length,
    totalActivity: activity.length,
  });
});

const INSIGHTS_TTL = 5 * 60 * 1000;
let insightsCache: { at: number; value: Insights } | null = null;

// Long-range aggregates. Cached because the page polls every 30s and these numbers move slowly.
router.get("/insights", (_req: Request, res: Response) => {
  if (!insightsCache || Date.now() - insightsCache.at > INSIGHTS_TTL) {
    insightsCache = { at: Date.now(), value: buildInsights() };
  }
  res.json(insightsCache.value);
});

export default router;
