/**
 * Daily Brief Composer — gathers awareness state, recent activity, schedule results,
 * and asks the background model to compose a natural summary.
 */
import { db } from "../db/index.js";
import { schedules, activityLog, mcpServers } from "../db/schema.js";
import { desc } from "drizzle-orm";
import { getAwarenessContext } from "../awareness/state.js";
import { backgroundCompletion } from "../lib/background-model.js";

export async function composeDailyBrief(): Promise<string> {
  // Gather data
  const allSchedules = db.select().from(schedules).all().filter((s) => s.enabled);
  const recentActivity = db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(10).all();
  const services = db.select().from(mcpServers).all();
  const awareness = getAwarenessContext();

  // Build data summary for the LLM
  let dataSummary = `Current time: ${new Date().toISOString()}\n\n`;
  dataSummary += awareness + "\n\n";

  if (services.length > 0) {
    dataSummary += "## MCP Servers\n";
    for (const s of services) {
      dataSummary += `- ${s.name}: enabled=${s.enabled}, health=${s.healthStatus}, reachable=${s.isReachable ?? "unknown"}\n`;
    }
    dataSummary += "\n";
  }

  if (allSchedules.length > 0) {
    dataSummary += "## Active Schedules\n";
    for (const s of allSchedules) {
      dataSummary += `- "${s.naturalLanguage}" (${s.cronExpression}) — last run: ${s.lastRun ?? "never"}, result: ${s.lastResult ?? "none"}\n`;
    }
    dataSummary += "\n";
  }

  if (recentActivity.length > 0) {
    dataSummary += "## Recent Activity\n";
    for (const a of recentActivity) {
      dataSummary += `- [${a.type}] ${a.summary} (${a.createdAt})\n`;
    }
  }

  try {
    return await backgroundCompletion({
      system: "You are Chomp, a personal AI assistant. Compose a brief, friendly morning summary for the user. Cover: service health, schedule results, anything notable. Be concise — 3-5 sentences max. Use plain text, no markdown headers.",
      prompt: dataSummary,
    });
  } catch (err) {
    console.error("[daily-brief] Failed to compose:", err instanceof Error ? err.message : err);
    // Fall back to a simple data dump
    return `Daily Brief (${new Date().toLocaleDateString()}):\n${services.length} services, ${allSchedules.length} schedules active. ${recentActivity.length} recent activities.`;
  }
}
