import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { dashboards, dashboardWidgets, chatMessages } from "../db/schema.js";
import { eq, asc, max as sqlMax } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  extractCanvasBlocks,
  classifyWidget,
  runWidgetRefresh,
  summarizeBlocksToSchema,
} from "../agents/widget-refresh.js";

const router: ReturnType<typeof Router> = Router();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function ensureUniqueDashboardSlug(base: string): string {
  let candidate = base || `dashboard-${Date.now()}`;
  let n = 1;
  while (db.select().from(dashboards).where(eq(dashboards.slug, candidate)).get()) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

function nextWidgetY(dashboardId: string): number {
  const row = db
    .select({ maxY: sqlMax(dashboardWidgets.gridY) })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboardId))
    .get();
  return (row?.maxY ?? -1) + 1;
}

// List widgets, optionally filtered by ?dashboardId=
router.get("/", (req: Request, res: Response) => {
  const dashboardId = req.query.dashboardId as string | undefined;
  const query = db
    .select()
    .from(dashboardWidgets)
    .orderBy(asc(dashboardWidgets.gridY), asc(dashboardWidgets.gridX));
  const rows = dashboardId
    ? query.where(eq(dashboardWidgets.dashboardId, dashboardId)).all()
    : query.all();
  res.json(rows.map((w) => ({ ...w, blocks: safeParseJson(w.blocks, [] as unknown[]) })));
});

// Get one widget
router.get("/:id", (req: Request, res: Response) => {
  const widget = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.id, req.params.id as string))
    .get();
  if (!widget) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json({ ...widget, blocks: safeParseJson(widget.blocks, [] as unknown[]) });
});

// Create widget directly (rare — usually clients call /from-message/:id instead)
router.post("/", (req: Request, res: Response) => {
  const { dashboardId, title, blocks, sourceMessageId, gridX, gridY, gridW, gridH } = req.body ?? {};
  if (!dashboardId || !title) {
    res.status(400).json({ error: "dashboardId and title are required" });
    return;
  }
  if (!db.select().from(dashboards).where(eq(dashboards.id, dashboardId)).get()) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(dashboardWidgets)
    .values({
      id,
      dashboardId,
      title,
      blocks: JSON.stringify(Array.isArray(blocks) ? blocks : []),
      sourceMessageId: sourceMessageId ?? null,
      gridX: typeof gridX === "number" ? gridX : 0,
      gridY: typeof gridY === "number" ? gridY : nextWidgetY(dashboardId),
      gridW: typeof gridW === "number" ? gridW : 1,
      gridH: typeof gridH === "number" ? gridH : 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, id)).get()!;
  res.status(201).json({ ...created, blocks: safeParseJson(created.blocks, [] as unknown[]) });
});

// Update widget (title / blocks / grid position)
router.put("/:id", (req: Request, res: Response) => {
  const existing = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.id, req.params.id as string))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  const { title, blocks, gridX, gridY, gridW, gridH } = req.body ?? {};
  db.update(dashboardWidgets)
    .set({
      ...(typeof title === "string" && { title }),
      ...(Array.isArray(blocks) && { blocks: JSON.stringify(blocks) }),
      ...(typeof gridX === "number" && { gridX }),
      ...(typeof gridY === "number" && { gridY }),
      ...(typeof gridW === "number" && { gridW }),
      ...(typeof gridH === "number" && { gridH }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dashboardWidgets.id, existing.id))
    .run();
  const updated = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, existing.id)).get()!;
  res.json({ ...updated, blocks: safeParseJson(updated.blocks, [] as unknown[]) });
});

// Delete widget
router.delete("/:id", (req: Request, res: Response) => {
  const existing = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.id, req.params.id as string))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, existing.id)).run();
  res.status(204).send();
});

// Pin a chat message to a dashboard.
// Body: { title, dashboardId? OR newDashboardName? }
router.post("/from-message/:messageId", (req: Request, res: Response) => {
  const messageId = req.params.messageId as string;
  const { title, dashboardId, newDashboardName } = req.body ?? {};
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!dashboardId && !newDashboardName) {
    res.status(400).json({ error: "dashboardId or newDashboardName is required" });
    return;
  }

  const message = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .get();
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const blocks = extractCanvasBlocks(message.content);
  if (blocks.length === 0) {
    res.status(400).json({ error: "Message contains no canvas blocks" });
    return;
  }

  let targetDashboardId = dashboardId as string | undefined;
  if (!targetDashboardId) {
    const finalSlug = ensureUniqueDashboardSlug(slugify(newDashboardName));
    const newId = randomUUID();
    const now = new Date().toISOString();
    db.insert(dashboards)
      .values({
        id: newId,
        name: newDashboardName,
        slug: finalSlug,
        description: "",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    targetDashboardId = newId;
  } else if (!db.select().from(dashboards).where(eq(dashboards.id, targetDashboardId)).get()) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }

  const widgetId = randomUUID();
  const now = new Date().toISOString();
  db.insert(dashboardWidgets)
    .values({
      id: widgetId,
      dashboardId: targetDashboardId,
      title,
      blocks: JSON.stringify(blocks),
      sourceMessageId: messageId,
      gridX: 0,
      gridY: nextWidgetY(targetDashboardId),
      gridW: 1,
      gridH: 1,
      classifying: true,
      schemaJson: JSON.stringify(summarizeBlocksToSchema(blocks)),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Kick off background classifier — non-blocking. Errors are written to the row.
  setImmediate(() => {
    classifyWidget(widgetId).catch((err) => {
      console.warn(`[widgets] classify ${widgetId} crashed:`, err instanceof Error ? err.message : err);
    });
  });

  const widget = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId)).get()!;
  res.status(201).json({
    ...widget,
    blocks: safeParseJson(widget.blocks, [] as unknown[]),
    dashboardId: targetDashboardId,
  });
});

// Manually update a widget's refresher (override what the classifier picked).
// Body: { kind: 'template' | 'agent' | null, payload: object | null, schema?: SchemaDescriptor[] }
router.put("/:id/refresher", async (req: Request, res: Response) => {
  const widget = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.id, req.params.id as string))
    .get();
  if (!widget) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  const { kind, payload, schema, refreshIntervalMinutes } = req.body ?? {};
  if (kind === "skill" || kind === "prompt") {
    res.status(400).json({
      error: `kind "${kind}" was retired in Phase 7. Use kind "template" (URL + transform recipe) or "agent" (claude -p fallback) instead.`,
    });
    return;
  }
  if (kind !== null && kind !== "template" && kind !== "agent") {
    res.status(400).json({ error: "kind must be 'template', 'agent', or null" });
    return;
  }
  if (kind !== null && (!payload || typeof payload !== "object")) {
    res.status(400).json({ error: "payload required when kind is not null" });
    return;
  }
  if (kind === "template") {
    const hasSingleUrl = typeof payload.url === "string" && payload.url.length > 0;
    const hasRequests =
      payload.requests !== null &&
      typeof payload.requests === "object" &&
      !Array.isArray(payload.requests) &&
      Object.keys(payload.requests).length > 0;
    if (!hasSingleUrl && !hasRequests) {
      res.status(400).json({ error: "template-kind payload requires 'url' or non-empty 'requests'" });
      return;
    }
    if (hasRequests) {
      for (const [key, request] of Object.entries(payload.requests as Record<string, unknown>)) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          res.status(400).json({ error: `template-kind request "${key}" must be an object` });
          return;
        }
        if (typeof (request as Record<string, unknown>).url !== "string" || !(request as Record<string, unknown>).url) {
          res.status(400).json({ error: `template-kind request "${key}" requires 'url'` });
          return;
        }
      }
    }
    if (payload.transform === undefined || payload.transform === null) {
      res.status(400).json({ error: "template-kind payload requires 'transform' (canvas-block template)" });
      return;
    }
    try {
      const { validateTemplateSyntax } = await import("../agents/widget-refresh-template.js");
      validateTemplateSyntax(payload.transform);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "template syntax error" });
      return;
    }
  }
  if (kind === "agent" && (typeof payload.prompt !== "string" || payload.prompt.length === 0)) {
    res.status(400).json({ error: "agent-kind payload requires 'prompt'" });
    return;
  }
  // refreshIntervalMinutes: number ≥ 1 enables auto-refresh, null disables. Frozen widgets force null.
  let nextInterval: number | null = widget.refreshIntervalMinutes ?? null;
  if (refreshIntervalMinutes === null) {
    nextInterval = null;
  } else if (typeof refreshIntervalMinutes === "number" && refreshIntervalMinutes >= 1) {
    nextInterval = Math.floor(refreshIntervalMinutes);
  }
  if (kind === null) nextInterval = null;
  db.update(dashboardWidgets)
    .set({
      refresherKind: kind ?? null,
      refresherPayload: kind === null ? null : JSON.stringify(payload),
      refreshIntervalMinutes: nextInterval,
      ...(Array.isArray(schema) && { schemaJson: JSON.stringify(schema) }),
      lastClassifyError: null,
      classifying: false,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dashboardWidgets.id, widget.id))
    .run();
  const updated = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widget.id)).get()!;
  res.json({ ...updated, blocks: safeParseJson(updated.blocks, [] as unknown[]) });
});

// Re-run the classifier for a widget that already exists (e.g. after editing it manually).
router.post("/:id/classify", (req: Request, res: Response) => {
  const widget = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.id, req.params.id as string))
    .get();
  if (!widget) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  db.update(dashboardWidgets)
    .set({ classifying: true, lastClassifyError: null, updatedAt: new Date().toISOString() })
    .where(eq(dashboardWidgets.id, widget.id))
    .run();
  setImmediate(() => {
    classifyWidget(widget.id).catch((err) => {
      console.warn(`[widgets] re-classify ${widget.id} crashed:`, err instanceof Error ? err.message : err);
    });
  });
  res.status(202).json({ id: widget.id, classifying: true });
});

// Run the saved refresher and replace the widget's blocks if the result matches the schema.
router.post("/:id/refresh", async (req: Request, res: Response) => {
  const result = await runWidgetRefresh(req.params.id as string);
  if (result.status === "not_found") {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  if (result.status === "no_refresher") {
    res.status(400).json({ error: "Widget has no refresher configured" });
    return;
  }
  if (result.status === "schema_mismatch") {
    res.status(422).json({
      error: "Refresh produced unexpected shape — kept frozen blocks",
      detail: result.reason ?? "Schema mismatch",
    });
    return;
  }
  if (result.status === "error") {
    res.status(500).json({ error: result.reason ?? "Refresh failed" });
    return;
  }
  res.json({ ...result.widget!, blocks: safeParseJson(result.widget!.blocks, [] as unknown[]) });
});

function safeParseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export default router;
