import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { mcpServers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { syncMcpServers, parseAndRunMcpAdd, getMcpLiveStatus, importFromClaudeDesktop } from "../sync/mcp.js";

const router: ReturnType<typeof Router> = Router();

// In-memory cache for live status — refreshed in background to avoid blocking requests
let liveCache: Array<{ name: string; status: string }> = [];
let liveCacheTs = 0;
let liveFetching = false;
const LIVE_TTL = 30_000;

function refreshLiveCache() {
  if (liveFetching) return;
  liveFetching = true;
  // Run in a microtask so the route responds before the slow CLI call
  setImmediate(() => {
    try {
      liveCache = getMcpLiveStatus();
      liveCacheTs = Date.now();
    } catch {
      // ignore
    } finally {
      liveFetching = false;
    }
  });
}

// Warm cache on startup
refreshLiveCache();

/** GET /api/mcp-servers/live — live status from claude mcp list (cached) */
router.get("/live", (_req: Request, res: Response) => {
  // Always respond immediately with current cache
  res.json(liveCache);
  // Kick off background refresh if stale
  if (Date.now() - liveCacheTs > LIVE_TTL) {
    refreshLiveCache();
  }
});

/** POST /api/mcp-servers/sync — re-sync all MCP servers */
router.post("/sync", (_req: Request, res: Response) => {
  syncMcpServers();
  res.json({ status: "synced" });
});

/** POST /api/mcp-servers/check-health — run health check on all servers */
router.post("/check-health", async (_req: Request, res: Response) => {
  const { runMcpHealthChecks } = await import("../health/mcp-health.js");
  await runMcpHealthChecks();
  const updated = db.select().from(mcpServers).all().map((s) => ({ ...s, config: JSON.parse(s.config), credentials: JSON.parse(s.credentials) }));
  res.json(updated);
});

/** POST /api/mcp-servers/add-command — parse and execute a claude mcp add command */
router.post("/add-command", (req: Request, res: Response) => {
  const { command } = req.body;
  if (!command) {
    res.status(400).json({ error: "command is required" });
    return;
  }
  const result = parseAndRunMcpAdd(command);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

/** POST /api/mcp-servers/import-desktop — import from Claude Desktop config */
router.post("/import-desktop", (_req: Request, res: Response) => {
  const result = importFromClaudeDesktop();
  if (result.error) {
    res.status(500).json(result);
  } else {
    res.json(result);
  }
});

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(mcpServers).all();
  const parsed = result.map((s) => ({
    ...s,
    config: JSON.parse(s.config),
    credentials: JSON.parse(s.credentials),
  }));
  res.json(parsed);
});

/** POST /api/mcp-servers/:id/health-check — on-demand health check for one server */
router.post("/:id/health-check", async (req: Request, res: Response) => {
  const server = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id as string)).get();
  if (!server) {
    res.status(404).json({ error: "MCP Server not found" });
    return;
  }
  const { checkSingleServer } = await import("../health/mcp-health.js");
  await checkSingleServer(server.id);
  const updated = db.select().from(mcpServers).where(eq(mcpServers.id, server.id)).get()!;
  res.json({ ...updated, config: JSON.parse(updated.config), credentials: JSON.parse(updated.credentials) });
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "MCP Server not found" });
    return;
  }
  res.json({ ...result, config: JSON.parse(result.config), credentials: JSON.parse(result.credentials) });
});

router.post("/", (req: Request, res: Response) => {
  const { name, description, config, credentials, enabled, healthCheckUrl, healthCheckInterval } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(mcpServers).values({
    id,
    name,
    description: description ?? "",
    config: JSON.stringify(config ?? {}),
    credentials: JSON.stringify(credentials ?? {}),
    enabled: enabled ?? true,
    healthCheckUrl: healthCheckUrl ?? null,
    healthCheckInterval: healthCheckInterval ?? 300,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()!;
  syncMcpServers();
  res.status(201).json({ ...created, config: JSON.parse(created.config), credentials: JSON.parse(created.credentials) });
});

router.put("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "MCP Server not found" });
    return;
  }

  const { name, description, config, credentials, enabled, healthCheckUrl, healthCheckInterval } = req.body;
  db.update(mcpServers).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(config !== undefined && { config: JSON.stringify(config) }),
    ...(credentials !== undefined && { credentials: JSON.stringify(credentials) }),
    ...(enabled !== undefined && { enabled }),
    ...(healthCheckUrl !== undefined && { healthCheckUrl }),
    ...(healthCheckInterval !== undefined && { healthCheckInterval }),
    updatedAt: new Date().toISOString(),
  }).where(eq(mcpServers.id, req.params.id as string)).run();

  const updated = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id as string)).get()!;
  syncMcpServers();
  res.json({ ...updated, config: JSON.parse(updated.config), credentials: JSON.parse(updated.credentials) });
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "MCP Server not found" });
    return;
  }
  db.delete(mcpServers).where(eq(mcpServers.id, req.params.id as string)).run();
  syncMcpServers();
  res.status(204).send();
});

export default router;
