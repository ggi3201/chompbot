import express, { type Express } from "express";
import compression from "compression";
import { createServer } from "http";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { VERSION } from "@chomp/shared";
import type { TurnNotice } from "./agents/turn-notice.js";
import { runMigrations } from "./db/index.js";
import { stopOrphanedSubagents } from "./agents/runtime/items.js";
import { authMiddleware, hasValidToken, mcpAuthMiddleware } from "./auth/middleware.js";
import authRoutes from "./auth/routes.js";
import skillsRoutes from "./routes/skills.js";
import mcpServersRoutes from "./routes/mcp-servers.js";
import pluginsRoutes from "./routes/plugins.js";

import memoriesRoutes from "./routes/memories.js";
import schedulesRoutes from "./routes/schedules.js";
import { SITES_DIR } from "./agents/tools/site-git.js";
import goodmorningRoutes from "./routes/goodmorning.js";
import dashboardRoutes from "./routes/dashboard.js";
import settingsRoutes from "./routes/settings.js";
import syncRoutes from "./routes/sync.js";
import conversationRoutes from "./routes/conversations.js";
import telegramRoutes from "./routes/telegram.js";
import discordRoutes from "./routes/discord.js";
import agentMonitorRoutes from "./routes/agent-monitor.js";
import triggersRoutes from "./routes/triggers.js";
import secretsRoutes from "./routes/secrets.js";
import uploadRoutes, { UPLOADS_DIR } from "./routes/uploads.js";
import { seedDefaults } from "./seed.js";
import { attachWebSocket } from "./chat/websocket.js";
import { attachDeviceBridgeWebSocket } from "./device-bridge/index.js";
import { attachPreviewWebSocket } from "./preview/socket.js";
import { attachTerminalWebSocket } from "./terminal/socket.js";
import mcpRoutes from "./mcp/server.js";
import { startTelegramBot } from "./telegram/bot.js";
import { startDiscordBot } from "./discord/bot.js";
import { startTriggerEvaluator } from "./events/trigger-evaluator.js";
import { startHomeAssistantLocation } from "./location/home-assistant.js";
import { startActivityLogger } from "./events/activity-logger.js";
import proactiveRulesRoutes from "./routes/proactive-rules.js";
import webhooksRoutes, { keepRawBody } from "./routes/webhooks.js";
import googleRoutes from "./routes/google.js";
import spotifyRoutes from "./routes/spotify.js";
import { startProactiveEngine } from "./proactive/engine.js";
import generateRoutes from "./routes/generate.js";
import chatMetaRoutes from "./routes/chat-meta.js";
import sitesRoutes from "./routes/sites.js";
import artifactsRoutes from "./routes/artifacts.js";
import sketchesRoutes from "./routes/sketches.js";
import voiceRoutes from "./routes/voice.js";
import soulsRoutes from "./routes/souls.js";
import birthrightRoutes from "./routes/birthright.js";
import projectsRoutes from "./routes/projects.js";
import filesRoutes from "./routes/files.js";
import terminalsRoutes from "./routes/terminals.js";
import dashboardsRoutes from "./routes/dashboards.js";
import widgetsRoutes from "./routes/widgets.js";
import backupsRoutes from "./routes/backups.js";
import agentRequestsRoutes from "./routes/agent-requests.js";
import deviceTokensRoutes from "./routes/device-tokens.js";
import phoneCardsRoutes from "./routes/phone-cards.js";
import todayRoutes from "./routes/today.js";
import phoneLocationRoutes from "./routes/phone-location.js";
import { askRoutes } from "./routes/ask.js";
import outsideMcpRoutes from "./routes/outside-mcp.js";
import monitoringRoutes, { monitoringHostReportRoutes, monitoringOutsideRoutes, monitoringPushRoutes } from "./routes/monitoring.js";
import socialPostsRoutes, { socialPostLinkRoutes } from "./routes/social-posts.js";
import { startSocialPostNotifier } from "./social-posts/notifier.js";
import { startDailyBackups } from "./lib/backup.js";
import { startDailyRetention } from "./lib/retention.js";
import { runStartupChecks, getHealthReport } from "./health/checks.js";
import { startMcpHealthMonitor } from "./health/mcp-health.js";

const app: Express = express();
const PORT: number = parseInt(process.env.PORT ?? "3002", 10);

// Tailscale serve passes responses through uncompressed, so compress here.
// Streams (SSE: MCP bridge, birthright; ndjson: project clone) must flush per event, so they are skipped.
app.use(compression({
  filter: (req, res) => !/event-stream|ndjson/.test(String(res.getHeader("Content-Type") ?? "")) && compression.filter(req, res),
}));

// Host agents report to Monitoring with a bearer token of their own, so they skip the login. Before the JSON parser below,
// because the report route sets a 1 MB limit of its own and a body parsed here would get 40 MB.
app.use("/api/monitoring/hosts", monitoringHostReportRoutes);
// The outside probe signs the exact bytes it sends, so its route reads the body raw, before the JSON parser below.
app.use("/api/monitoring/outside", monitoringOutsideRoutes);

// Sized to comfortably fit a 25 MB uploaded file encoded as base64
// (base64 inflates payload by ~4/3, so 25 MB ≈ 34 MB of JSON).
app.use(express.json({ limit: "40mb", verify: keepRawBody }));

// The commit this process booted from; the web UI compares it to spot a deploy.
const BUILD = (() => {
  try {
    const [sha, subject] = execFileSync("git", ["log", "-1", "--format=%h%x00%s"], {
      cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8",
    }).trim().split("\0");
    return { sha, subject };
  } catch {
    return null;
  }
})();

// Public routes
app.get("/api/health", async (req, res) => {
  const { getAwarenessSnapshot } = await import("./awareness/state.js");
  // Without a login only what a deploy check needs: whether the owner is online, what runs and the host's accounts are not public.
  if (!hasValidToken(req)) {
    res.json({ status: "ok", version: VERSION, build: BUILD });
    return;
  }
  res.json({ status: "ok", version: VERSION, build: BUILD, awareness: getAwarenessSnapshot(), health: getHealthReport() });
});
app.use("/api/auth", authRoutes);

// Internal endpoint for worker → API agent dispatch: the MCP secret, or a direct local request
app.post("/api/internal/dispatch", mcpAuthMiddleware, async (req, res) => {
  const { agent, prompt, scheduleId, scheduleName } = req.body;
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const { dispatchToAgent } = await import("./agents/dispatch.js");
    const { runTargetFrom } = await import("./agents/run-target.js");
    const { sendTurnNotice } = await import("./agents/turn-notice.js");
    const { conversations } = await import("./db/schema.js");
    const { randomUUID } = await import("crypto");
    const { db } = await import("./db/index.js");
    const { eq } = await import("drizzle-orm");
    const { emit } = await import("./events/bus.js");

    // Reuse or create a conversation for this schedule
    const convTitle = `Schedule: ${scheduleName ?? scheduleId ?? "unknown"}`;
    const existing = db.select().from(conversations).all().find((c) => c.title === convTitle);
    let convId: string;
    const now = new Date().toISOString();
    if (existing) {
      convId = existing.id;
      db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, convId)).run();
    } else {
      convId = randomUUID();
      db.insert(conversations).values({ id: convId, title: convTitle, createdAt: now, updatedAt: now }).run();
    }

    const ctx = { conversationId: convId, send: () => {} };
    const routing = { action: "delegate" as const, ...(typeof agent === "string" && agent ? { agent } : {}), prompt, reason: "scheduled task" };
    const notice: TurnNotice = { type: "schedule-result", title: scheduleName ?? "Scheduled task", conversationId: convId, since: now };
    const result = await dispatchToAgent(routing, ctx, { ...runTargetFrom(req.body), notifyWhenDone: notice });

    // Always notify the user with the result — broadcast to all channels
    await sendTurnNotice(notice, result.response);

    if (scheduleId) {
      emit({
        type: "schedule.completed",
        scheduleId,
        scheduleName: scheduleName ?? scheduleId,
        result: result.response?.slice(0, 500) ?? "",
      });
    }

    res.json({ ok: true, response: result.response?.slice(0, 500) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[internal/dispatch] Error:", msg);
    if (scheduleId) {
      const { emit } = await import("./events/bus.js");
      emit({
        type: "schedule.failed",
        scheduleId,
        scheduleName: scheduleName ?? scheduleId,
        error: msg,
      });
    }
    res.status(500).json({ error: msg });
  }
});

// Internal endpoint for the worker → API auto-refresh of a widget: the MCP secret, or a direct local request.
// Mirrors POST /api/widgets/:id/refresh for the worker, which has no login.
app.post("/api/internal/refresh-widget/:id", mcpAuthMiddleware, async (req, res) => {
  try {
    const { runWidgetRefresh } = await import("./agents/widget-refresh.js");
    const result = await runWidgetRefresh(String(req.params.id));
    if (result.status === "not_found") {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    if (result.status === "no_refresher") {
      res.status(400).json({ error: "Widget has no refresher configured" });
      return;
    }
    if (result.status === "schema_mismatch") {
      res.status(422).json({ error: "Schema mismatch", detail: result.reason });
      return;
    }
    if (result.status === "error") {
      res.status(500).json({ error: result.reason ?? "Refresh failed" });
      return;
    }
    res.json({ ok: true, widgetId: req.params.id, lastRefreshedAt: result.widget!.lastRefreshedAt });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal refresh failed" });
  }
});

// Static uploads (public by UUID)
app.use("/api/uploads", express.static(UPLOADS_DIR));
// Published sites, public like any website. Dotfiles (a site's .git) are never served.
app.use("/pub", express.static(SITES_DIR));

// Artifacts (public by UUID, served in a CSP sandbox)
app.use("/api/artifacts", artifactsRoutes);

// Webhooks: receive endpoint is public, CRUD is protected (handled internally)
app.use("/api/webhooks", webhooksRoutes);

// Google: callback is public, other endpoints need auth (handled internally)
app.use("/api/google", googleRoutes);

// Spotify: callback is public, other endpoints need auth (handled internally)
app.use("/api/spotify", spotifyRoutes);

// Morning report: its own key, so a link from Telegram opens without a login
app.use("/api/goodmorning", goodmorningRoutes);
app.use("/api/social-post-link", socialPostLinkRoutes);

// Agents outside Chomp (Claude Code on the Mac, Codex): their own tokens, and only the tools in outside-mcp.ts
app.use("/api/outside-mcp", outsideMcpRoutes);

// Push jobs report to Monitoring with a token in the URL, so they skip the login
app.use("/api/monitoring/push", monitoringPushRoutes);

// Protected routes
app.use("/api", authMiddleware);
app.use("/api/skills", skillsRoutes);
app.use("/api/mcp-servers", mcpServersRoutes);
app.use("/api/plugins", pluginsRoutes);

app.use("/api/memories", memoriesRoutes);
app.use("/api/schedules", schedulesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/sketches", sketchesRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/discord", discordRoutes);
app.use("/api/agent-monitor", agentMonitorRoutes);
app.use("/api/triggers", triggersRoutes);
app.use("/api/settings/secrets", secretsRoutes);
app.use("/api/proactive-rules", proactiveRulesRoutes);
app.use("/api/generate", generateRoutes);
app.use("/api/chat", chatMetaRoutes);
app.use("/api/sites", sitesRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/souls", soulsRoutes);
app.use("/api/birthright", birthrightRoutes);
app.use("/api/projects", projectsRoutes);
app.use("/api/files", filesRoutes);
app.use("/api/terminals", terminalsRoutes);
app.use("/api/dashboards", dashboardsRoutes);
app.use("/api/widgets", widgetsRoutes);
app.use("/api/backups", backupsRoutes);
app.use("/api/agent-requests", agentRequestsRoutes);
app.use("/api/device-tokens", deviceTokensRoutes);
app.use("/api/phone-cards", phoneCardsRoutes);
app.use("/api/today", todayRoutes);
app.use("/api/phone-location", phoneLocationRoutes);
app.use("/api/ask", askRoutes());
app.use("/api/social-posts", socialPostsRoutes);
app.use("/api/monitoring", monitoringRoutes);

// MCP endpoints (used by claude -p via HTTP)
app.use("/mcp", mcpAuthMiddleware, mcpRoutes);

// Serve web build in production (single-server mode)
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = join(__dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist, {
    // Vite fingerprints everything in /assets, so those never change; index.html must always be rechecked.
    setHeaders: (res, path) => {
      if (path.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));
  app.get("{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(join(webDist, "index.html"));
  });
}

// Run migrations and seed on startup
runMigrations();
seedDefaults();
runStartupChecks();
stopOrphanedSubagents();

// Reconnect to agents that survived an API restart
import("./agents/reconnect.js").then(({ reconnectSurvivingAgents }) => {
  try {
    const result = reconnectSurvivingAgents();
    if (result.reconnected + result.crashed > 0) {
      console.log(`[startup] Agent reconnect: ${result.reconnected} alive, ${result.crashed} crashed`);
    }
  } catch (err) {
    console.warn("[startup] Agent reconnect failed:", err instanceof Error ? err.message : err);
  }
});

// Sync skills from ~/.claude/skills/ into DB on every startup
import("./sync/import.js").then(({ importSkills }) => {
  try {
    const result = importSkills();
    if (result.imported + result.updated > 0) {
      console.log(`[startup] Skills synced: ${result.imported} imported, ${result.updated} updated`);
    }
  } catch (err) {
    console.warn("[startup] Skills sync failed:", err instanceof Error ? err.message : err);
  }
});

const server = createServer(app);
attachWebSocket(server);
attachDeviceBridgeWebSocket(server);
attachPreviewWebSocket(server);
attachTerminalWebSocket(server);

// Start Telegram bot if configured
startTelegramBot();

// Start Discord bot if configured
startDiscordBot();

// Start event trigger evaluator
startTriggerEvaluator();
startHomeAssistantLocation();

// Start activity logger (persists events to activity_log table)
startActivityLogger();

// Start proactive engine
startProactiveEngine();
startSocialPostNotifier();

// Daily SQLite online backup with retention pruning
startDailyBackups();
startDailyRetention();

// Start MCP server health monitor
startMcpHealthMonitor();

import("./monitoring/start.js").then(({ startMonitoring }) => startMonitoring());

// Loopback by default: the first visitor sets the password, so a fresh install must not be on the LAN. `tailscale serve` reaches it here.
const HOST = process.env.HOST ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`Chomp API running on ${HOST}:${PORT}`);
  import("./events/bus.js").then(({ emit }) => emit({ type: "system.startup" }));

  // Register MCP bridge with Claude Code and Codex, and sync skills
  import("./sync/mcp.js").then(({ syncMcpServers, syncSkillsToCodex }) => {
    try {
      syncMcpServers();
      syncSkillsToCodex();
      console.log("[startup] MCP servers and skills synced");
    } catch (err) {
      console.warn("[startup] MCP sync failed:", err instanceof Error ? err.message : err);
    }
    // After the MCP sync, so resumed agents reach this API's bridge; the delay
    // lets browsers reconnect first and see the turn pick up.
    setTimeout(() => {
      import("./agents/runtime/resume.js").then(({ resumeInterruptedTurns }) => resumeInterruptedTurns());
    }, 3000).unref();
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────
// CLI agents run as children of this process (one Claude Code / Codex session
// per conversation), so a restart ends any turn in flight and any background
// subagent. Sessions with either are saved and resumed once on startup; truly
// idle sessions are left alone, and their next message resumes them.

function gracefulShutdown(signal: string) {
  // At once: the close below waits for open sockets, and the process may be killed before it exits.
  import("./preview/servers.js").then(({ stopAllServers }) => stopAllServers());
  import("./agents/runtime/pool.js").then(({ suspendForShutdown }) => {
    const saved = suspendForShutdown();
    console.log(`[shutdown] ${signal} received, ${saved} running agent turn(s) saved to resume after the restart`);
    server.close(() => {
      console.log("[shutdown] HTTP server closed — exiting");
      process.exit(0);
    });
    // Force exit after 5s if server.close() hangs (e.g. open WebSocket connections)
    setTimeout(() => {
      console.warn("[shutdown] Forced exit after timeout");
      process.exit(0);
    }, 5000).unref();
  });
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };
