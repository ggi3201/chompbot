import { VERSION } from "@chomp/shared";
import { startHeartbeat } from "./heartbeat.js";
import { startHealthMonitor } from "./health-monitor.js";
import { startWidgetRefreshTick } from "./widget-refresh-tick.js";
import { createWorker } from "./queue.js";
import { randomUUID } from "crypto";
import { db } from "./db.js";
import { activityLog } from "./schema.js";

console.log(`Chomp Worker v${VERSION} starting...`);

// Start the heartbeat scheduler
startHeartbeat();

// Start service health monitoring
startHealthMonitor();

// Auto-refresh due dashboard widgets (cost-gated by dashboard.auto_refresh_enabled)
startWidgetRefreshTick();

// Agent job worker — processes delegated tasks from heartbeat
const agentWorker = createWorker("agent-jobs", async (job) => {
  const { scheduleId, agent, prompt } = job.data as {
    scheduleId: string;
    agent: string;
    prompt: string;
  };

  console.log(`[agent-job] Processing: agent=${agent}, schedule=${scheduleId}`);

  // Log the job
  db.insert(activityLog).values({
    id: randomUUID(),
    type: "agent",
    summary: `Agent job: ${agent} for schedule ${scheduleId}`,
    details: JSON.stringify({ agent, prompt, scheduleId }),
    scheduleId: scheduleId as string,
    agentUsed: agent as string,
    createdAt: new Date().toISOString(),
  }).run();

  // Agent execution will be handled by the API's dispatch system
  // The worker queues the intent; the API processes it
  return { status: "queued", agent, scheduleId };
});

agentWorker.on("completed", (job) => {
  console.log(`[agent-job] Completed: ${job.id}`);
});

agentWorker.on("failed", (job, err) => {
  console.error(`[agent-job] Failed: ${job?.id}`, err.message);
});

console.log("Chomp Worker ready.");
