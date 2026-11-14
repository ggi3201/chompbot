/**
 * MCP Server health monitoring.
 *
 * Periodically pings each registered MCP server:
 *  - HTTP/SSE servers: direct fetch to the server URL
 *  - stdio servers: checked via `claude mcp list` live status
 *
 * Status changes (reachable → unreachable and vice versa) trigger
 * a broadcast notification to all available channels (web + Telegram).
 */

import { db } from "../db/index.js";
import { mcpServers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { notify } from "../notifications/router.js";

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 30_000; // wait 30s after startup before first run
const HTTP_TIMEOUT_MS = 5_000;

/** In-memory map of server id → last known reachability state */
const previousReachable = new Map<string, boolean>();

async function checkHttpReachable(url: string): Promise<{ reachable: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      await fetch(url, { method: "HEAD", signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    return { reachable: true, latencyMs: Date.now() - start };
  } catch {
    return { reachable: false, latencyMs: Date.now() - start };
  }
}

/** Run a health check on a single server by ID and update its DB record.
 *  Returns { isReachable, latencyMs }. */
export async function checkSingleServer(id: string): Promise<{ isReachable: boolean; latencyMs: number | null }> {
  const server = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  if (!server) return { isReachable: false, latencyMs: null };

  const config = JSON.parse(server.config) as Record<string, unknown>;
  const url = config.url as string | undefined;

  let isReachable: boolean;
  let latencyMs: number | null = null;

  if (url) {
    const result = await checkHttpReachable(url);
    isReachable = result.reachable;
    latencyMs = result.latencyMs;
  } else {
    // stdio server — check via claude mcp list live status
    let liveStatuses: Array<{ name: string; status: string }> = [];
    try {
      const { getMcpLiveStatus } = await import("../sync/mcp.js");
      liveStatuses = getMcpLiveStatus();
    } catch {
      // ignore CLI errors
    }
    const live = liveStatuses.find((s) => s.name === server.name);
    isReachable = live !== undefined &&
      (live.status === "connected" || live.status === "running" || live.status === "ok");
  }

  const now = new Date().toISOString();
  db.update(mcpServers)
    .set({ lastHealthCheck: now, isReachable, latencyMs })
    .where(eq(mcpServers.id, id))
    .run();

  return { isReachable, latencyMs };
}

/** Run health checks on all enabled MCP servers and send change notifications. */
export async function runMcpHealthChecks(): Promise<void> {
  const servers = db.select().from(mcpServers).all();
  if (servers.length === 0) return;

  // Fetch live status once for all stdio servers (single CLI call)
  let liveStatuses: Array<{ name: string; status: string }> = [];
  try {
    const { getMcpLiveStatus } = await import("../sync/mcp.js");
    liveStatuses = getMcpLiveStatus();
  } catch {
    // ignore — will mark stdio servers unreachable if CLI fails
  }

  for (const server of servers) {
    if (!server.enabled) continue;

    const config = JSON.parse(server.config) as Record<string, unknown>;
    const url = config.url as string | undefined;

    let isReachable: boolean;
    let latencyMs: number | null = null;

    if (url) {
      const result = await checkHttpReachable(url);
      isReachable = result.reachable;
      latencyMs = result.latencyMs;
    } else {
      const live = liveStatuses.find((s) => s.name === server.name);
      isReachable = live !== undefined &&
        (live.status === "connected" || live.status === "running" || live.status === "ok");
    }

    const now = new Date().toISOString();
    db.update(mcpServers)
      .set({ lastHealthCheck: now, isReachable, latencyMs })
      .where(eq(mcpServers.id, server.id))
      .run();

    // Notify on status transition (skip first run — no previous state yet)
    const prev = previousReachable.get(server.id);
    if (prev !== undefined && prev !== isReachable) {
      if (!isReachable) {
        notify({
          type: "system",
          title: `MCP Server Down: ${server.name}`,
          body: `The MCP server "${server.name}" is no longer reachable. Agents may have reduced tool access.`,
          broadcast: true,
        }).catch(() => {});
      } else {
        notify({
          type: "system",
          title: `MCP Server Recovered: ${server.name}`,
          body: `The MCP server "${server.name}" is back online.`,
          broadcast: true,
        }).catch(() => {});
      }
    }

    previousReachable.set(server.id, isReachable);
  }

  console.log(`[mcp-health] Checked ${servers.filter((s) => s.enabled).length} server(s)`);
}

/** Start the background MCP health monitor. */
export function startMcpHealthMonitor(): void {
  setTimeout(() => {
    runMcpHealthChecks().catch((err) =>
      console.error("[mcp-health] Error in initial health check:", err),
    );
  }, INITIAL_DELAY_MS);

  setInterval(() => {
    runMcpHealthChecks().catch((err) =>
      console.error("[mcp-health] Error in periodic health check:", err),
    );
  }, HEALTH_CHECK_INTERVAL_MS);

  console.log("[mcp-health] Monitor started (interval: 5 min)");
}
