import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { dashboards, dashboardWidgets } from "../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { randomUUID } from "crypto";

const router: ReturnType<typeof Router> = Router();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// List dashboards (each with its widget count for the sidebar)
router.get("/", (_req: Request, res: Response) => {
  const all = db.select().from(dashboards).orderBy(asc(dashboards.name)).all();
  const widgetCounts = new Map<string, number>();
  for (const w of db.select({ id: dashboardWidgets.id, dashboardId: dashboardWidgets.dashboardId }).from(dashboardWidgets).all()) {
    widgetCounts.set(w.dashboardId, (widgetCounts.get(w.dashboardId) ?? 0) + 1);
  }
  res.json(all.map((d) => ({ ...d, widgetCount: widgetCounts.get(d.id) ?? 0 })));
});

// Get one dashboard with its widgets (sorted by gridY, then gridX, then created_at)
router.get("/:id", (req: Request, res: Response) => {
  const dashboard = db
    .select()
    .from(dashboards)
    .where(eq(dashboards.id, req.params.id as string))
    .get();
  if (!dashboard) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }
  const widgets = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboard.id))
    .orderBy(asc(dashboardWidgets.gridY), asc(dashboardWidgets.gridX), asc(dashboardWidgets.createdAt))
    .all();

  res.json({
    ...dashboard,
    widgets: widgets.map((w) => ({
      ...w,
      blocks: safeParseJson(w.blocks, [] as unknown[]),
    })),
  });
});

// Create dashboard
router.post("/", (req: Request, res: Response) => {
  const { name, slug, description } = req.body ?? {};
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const finalSlug = ensureUniqueSlug(slug ? slugify(slug) : slugify(name));
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(dashboards)
    .values({
      id,
      name,
      slug: finalSlug,
      description: description ?? "",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = db.select().from(dashboards).where(eq(dashboards.id, id)).get()!;
  res.status(201).json({ ...created, widgetCount: 0 });
});

// Update dashboard (name / slug / description)
router.put("/:id", (req: Request, res: Response) => {
  const existing = db
    .select()
    .from(dashboards)
    .where(eq(dashboards.id, req.params.id as string))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }
  const { name, slug, description, autoRefreshEnabled } = req.body ?? {};
  let nextSlug = existing.slug;
  if (slug !== undefined && slug !== existing.slug) {
    const candidate = slugify(slug);
    if (db.select().from(dashboards).where(eq(dashboards.slug, candidate)).get()) {
      res.status(409).json({ error: `Slug "${candidate}" already exists` });
      return;
    }
    nextSlug = candidate;
  }
  db.update(dashboards)
    .set({
      name: name ?? existing.name,
      slug: nextSlug,
      description: description ?? existing.description,
      ...(typeof autoRefreshEnabled === "boolean" && { autoRefreshEnabled }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dashboards.id, existing.id))
    .run();
  const updated = db.select().from(dashboards).where(eq(dashboards.id, existing.id)).get()!;
  res.json(updated);
});

// Delete dashboard (cascades to its widgets via FK)
router.delete("/:id", (req: Request, res: Response) => {
  const existing = db
    .select()
    .from(dashboards)
    .where(eq(dashboards.id, req.params.id as string))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }
  db.delete(dashboards).where(eq(dashboards.id, existing.id)).run();
  res.status(204).send();
});

// Bulk update widget grid positions for a dashboard.
// Body: [{ id, x, y, w, h }]
router.patch("/:id/layout", (req: Request, res: Response) => {
  const dashboardId = req.params.id as string;
  const dashboard = db.select().from(dashboards).where(eq(dashboards.id, dashboardId)).get();
  if (!dashboard) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }
  const items = Array.isArray(req.body) ? req.body : [];
  const now = new Date().toISOString();
  for (const r of items as { id?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }[]) {
    if (typeof r?.id !== "string") continue;
    db.update(dashboardWidgets)
      .set({
        ...(typeof r.x === "number" && { gridX: r.x }),
        ...(typeof r.y === "number" && { gridY: r.y }),
        ...(typeof r.w === "number" && { gridW: r.w }),
        ...(typeof r.h === "number" && { gridH: r.h }),
        updatedAt: now,
      })
      .where(eq(dashboardWidgets.id, r.id))
      .run();
  }
  res.status(204).send();
});

// ── helpers ───────────────────────────────────────────────────────────

function ensureUniqueSlug(base: string): string {
  let candidate = base || `dashboard-${Date.now()}`;
  let n = 1;
  while (db.select().from(dashboards).where(eq(dashboards.slug, candidate)).get()) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

function safeParseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export default router;
