import { internalAuth } from "./internal-auth.js";
import { db } from "./db.js";
import { schedules, souls, activityLog } from "./schema.js";
import { eq } from "drizzle-orm";

import { Ollama } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { randomUUID } from "crypto";
import { notifyScheduleResult } from "./notify.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
const API_URL = process.env.API_URL ?? "http://localhost:3001";
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

const ollama = new Ollama({ host: OLLAMA_HOST });

const ScheduleActionSchema = z.object({
  action: z.enum(["direct", "delegate"]),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  response: z.string().optional(),
});

/** Check if a schedule is due based on its cron expression and last run */
function isDue(cronExpr: string, lastRun: string | null): boolean {
  const now = new Date();
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minStr, hourStr, domStr, monStr, dowStr] = parts;

  function matches(field: string, value: number, max: number): boolean {
    if (field === "*") return true;
    // Handle */N step values
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return value % step === 0;
    }
    // Handle comma-separated values
    const values = field.split(",").map((v) => parseInt(v, 10));
    return values.includes(value);
  }

  const minuteOk = matches(minStr, now.getMinutes(), 59);
  const hourOk = matches(hourStr, now.getHours(), 23);
  const domOk = matches(domStr, now.getDate(), 31);
  const monOk = matches(monStr, now.getMonth() + 1, 12);
  const dowOk = matches(dowStr, now.getDay(), 6);

  if (!(minuteOk && hourOk && domOk && monOk && dowOk)) return false;

  // Don't re-run if already ran this minute
  if (lastRun) {
    const lastDate = new Date(lastRun);
    if (
      lastDate.getFullYear() === now.getFullYear() &&
      lastDate.getMonth() === now.getMonth() &&
      lastDate.getDate() === now.getDate() &&
      lastDate.getHours() === now.getHours() &&
      lastDate.getMinutes() === now.getMinutes()
    ) {
      return false;
    }
  }

  return true;
}

async function processSchedule(schedule: typeof schedules.$inferSelect) {
  const context = JSON.parse(schedule.context);
  const agentList = db.select().from(souls).all()
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  const prompt = `You are evaluating a scheduled task that is now due.

Schedule: "${schedule.naturalLanguage}"
${context.prompt ? `Additional context: ${context.prompt}` : ""}
${context.services?.length ? `Related services: ${context.services.join(", ")}` : ""}

Available agents:
${agentList}

Decide: Can you handle this directly with a brief status update, or should you delegate to an agent?
If delegating, choose the best agent and construct a focused prompt for it.

Respond as JSON only.`;

  try {
    const response = await ollama.chat({
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: prompt }],
      format: zodToJsonSchema(ScheduleActionSchema),
      options: { temperature: 0.1 },
    });

    const decision = ScheduleActionSchema.parse(JSON.parse(response.message.content));
    const now = new Date().toISOString();

    // Log activity
    db.insert(activityLog).values({
      id: randomUUID(),
      type: "schedule",
      summary: `Schedule "${schedule.naturalLanguage}" — ${decision.action === "direct" ? "handled directly" : `delegated to ${decision.agent}`}`,
      details: JSON.stringify(decision),
      scheduleId: schedule.id,
      agentUsed: decision.agent ?? null,
      createdAt: now,
    }).run();

    // Update last run
    db.update(schedules).set({
      lastRun: now,
      lastResult: decision.action === "direct"
        ? decision.response ?? "Completed"
        : `Delegating to ${decision.agent}...`,
      updatedAt: now,
    }).where(eq(schedules.id, schedule.id)).run();

    console.log(`[heartbeat] Processed: "${schedule.naturalLanguage}" → ${decision.action}`);

    if (decision.action === "direct") {
      // Notify about direct completion
      notifyScheduleResult(
        `Schedule completed`,
        `"${schedule.naturalLanguage}" — ${decision.response?.slice(0, 200) ?? "done"}`,
      ).catch(() => {});
    } else if (decision.action === "delegate" && decision.agent) {
      // Actually dispatch the agent via the API (worker can't import API modules directly)
      console.log(`[heartbeat] Dispatching agent "${decision.agent}" for schedule "${schedule.naturalLanguage}"`);
      try {
        const resp = await fetch(`${API_URL}/api/internal/dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...internalAuth },
          body: JSON.stringify({
            // The schedule's own choice of agent and model wins over the model's pick.
            ...(context.target?.soulId ? {} : { agent: decision.agent }),
            ...context.target,
            prompt: decision.prompt ?? schedule.naturalLanguage,
            scheduleId: schedule.id,
            scheduleName: schedule.naturalLanguage,
          }),
        });
        const result = await resp.json() as { ok?: boolean; response?: string; error?: string };
        const resultSummary = result.ok
          ? result.response?.slice(0, 200) ?? "completed"
          : `error: ${result.error}`;

        db.update(schedules).set({
          lastResult: `Agent ${decision.agent}: ${resultSummary}`,
          updatedAt: new Date().toISOString(),
        }).where(eq(schedules.id, schedule.id)).run();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "dispatch failed";
        console.error(`[heartbeat] Agent dispatch failed:`, errMsg);
        notifyScheduleResult(
          `Schedule dispatch failed`,
          `"${schedule.naturalLanguage}" — could not reach agent ${decision.agent}: ${errMsg}`,
        ).catch(() => {});
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[heartbeat] Failed to process "${schedule.naturalLanguage}":`, errMsg);

    db.update(schedules).set({
      lastRun: new Date().toISOString(),
      lastResult: `Error: ${errMsg}`,
      updatedAt: new Date().toISOString(),
    }).where(eq(schedules.id, schedule.id)).run();

    db.insert(activityLog).values({
      id: randomUUID(),
      type: "schedule",
      summary: `Schedule "${schedule.naturalLanguage}" failed: ${errMsg}`,
      scheduleId: schedule.id,
      createdAt: new Date().toISOString(),
    }).run();

    // Notify about schedule failure
    notifyScheduleResult(
      `Schedule failed`,
      `"${schedule.naturalLanguage}" — ${errMsg}`,
    ).catch(() => {});
  }
}

async function heartbeatTick() {
  const enabledSchedules = db.select().from(schedules).all().filter((s) => s.enabled);

  for (const schedule of enabledSchedules) {
    if (isDue(schedule.cronExpression, schedule.lastRun)) {
      await processSchedule(schedule);
    }
  }
}

export function startHeartbeat() {
  console.log(`[heartbeat] Starting with ${HEARTBEAT_INTERVAL_MS / 1000}s interval`);

  // Run immediately on start
  heartbeatTick().catch((err) => console.error("[heartbeat] Initial tick error:", err));

  // Then on interval
  setInterval(() => {
    heartbeatTick().catch((err) => console.error("[heartbeat] Tick error:", err));
  }, HEARTBEAT_INTERVAL_MS);
}
