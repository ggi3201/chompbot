/**
 * MCP Server Health Monitor — runs on the worker process.
 * Polls MCP servers with healthCheckUrl at their configured interval.
 * Updates DB and sends Telegram notification on status change.
 */
import { db } from "./db.js";
import { mcpServers } from "./schema.js";
import { eq } from "drizzle-orm";
import { notifyScheduleResult } from "./notify.js";

const CHECK_INTERVAL_MS = 60_000; // Run every 60s
const REQUEST_TIMEOUT_MS = 10_000;

function determineStatus(consecutiveFailures: number): "healthy" | "degraded" | "down" {
  if (consecutiveFailures >= 3) return "down";
  if (consecutiveFailures >= 1) return "degraded";
  return "healthy";
}

async function checkServer(server: typeof mcpServers.$inferSelect) {
  if (!server.healthCheckUrl) return;

  const now = new Date();

  // Check if it's time based on interval
  if (server.lastHealthCheck) {
    const lastCheck = new Date(server.lastHealthCheck);
    const elapsed = (now.getTime() - lastCheck.getTime()) / 1000;
    if (elapsed < server.healthCheckInterval) return;
  }

  let isHealthy = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(server.healthCheckUrl, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    isHealthy = response.ok;
  } catch {
    isHealthy = false;
  }

  const newFailures = isHealthy ? 0 : server.consecutiveFailures + 1;
  const newStatus = determineStatus(newFailures);
  const oldStatus = server.healthStatus;
  const statusChanged = oldStatus !== newStatus;

  // Update DB
  db.update(mcpServers)
    .set({
      lastHealthCheck: now.toISOString(),
      healthStatus: newStatus,
      consecutiveFailures: newFailures,
      updatedAt: now.toISOString(),
    })
    .where(eq(mcpServers.id, server.id))
    .run();

  if (statusChanged) {
    console.log(`[health-monitor] ${server.name}: ${oldStatus} → ${newStatus}`);

    // Notify via Telegram
    if (newStatus === "down") {
      notifyScheduleResult(
        `MCP Server Down: ${server.name}`,
        `${server.name} is unreachable after 3 consecutive failures.`,
      ).catch(() => {});
    } else if (newStatus === "healthy" && oldStatus === "down") {
      notifyScheduleResult(
        `MCP Server Recovered: ${server.name}`,
        `${server.name} is back online.`,
      ).catch(() => {});
    }
  }
}

async function healthCheckTick() {
  const servers = db.select().from(mcpServers).all();
  const withHealthCheck = servers.filter((s) => s.healthCheckUrl && s.enabled);

  for (const server of withHealthCheck) {
    await checkServer(server);
  }
}

export function startHealthMonitor() {
  console.log(`[health-monitor] Starting with ${CHECK_INTERVAL_MS / 1000}s interval`);

  // Run first tick after a short delay to let DB settle
  setTimeout(() => {
    healthCheckTick().catch((err) => console.error("[health-monitor] Initial tick error:", err));
  }, 5000);

  setInterval(() => {
    healthCheckTick().catch((err) => console.error("[health-monitor] Tick error:", err));
  }, CHECK_INTERVAL_MS);
}
