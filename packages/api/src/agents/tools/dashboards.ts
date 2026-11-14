/**
 * MCP-tool implementation for dashboards + widgets.
 * Mirrors the validation in routes/dashboards.ts and routes/widgets.ts.
 *
 * Each exec* function returns a plain string, "ERROR:" prefix on failure
 * (per chomp's tool convention — wrapExec in tool-handlers.ts converts to
 * the MCP {content, isError} shape).
 */

import { db } from "../../db/index.js";
import { dashboards, dashboardWidgets } from "../../db/schema.js";
import { eq, asc, max as sqlMax } from "drizzle-orm";
import { randomUUID } from "crypto";

interface CanvasBlock {
  type: string;
  [key: string]: unknown;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

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

function findDashboardByIdOrSlug(args: {
  id?: string;
  slug?: string;
  dashboardId?: string;
  dashboardSlug?: string;
}): typeof dashboards.$inferSelect | null {
  const id = args.id ?? args.dashboardId;
  const slug = args.slug ?? args.dashboardSlug;
  if (id) {
    const row = db.select().from(dashboards).where(eq(dashboards.id, id)).get();
    if (row) return row;
  }
  if (slug) {
    const row = db.select().from(dashboards).where(eq(dashboards.slug, slug)).get();
    if (row) return row;
  }
  return null;
}

function nextWidgetY(dashboardId: string): number {
  const row = db
    .select({ maxY: sqlMax(dashboardWidgets.gridY) })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboardId))
    .get();
  return (row?.maxY ?? -1) + 1;
}

// ── List / get ─────────────────────────────────────────────────────────

export async function execListDashboards(): Promise<string> {
  const all = db.select().from(dashboards).orderBy(asc(dashboards.name)).all();
  if (all.length === 0) {
    return "No dashboards yet. Create one with chomp_create_dashboard.";
  }
  const counts = new Map<string, number>();
  for (const w of db.select({ id: dashboardWidgets.id, dashboardId: dashboardWidgets.dashboardId }).from(dashboardWidgets).all()) {
    counts.set(w.dashboardId, (counts.get(w.dashboardId) ?? 0) + 1);
  }
  const lines = all.map((d) => {
    const wc = counts.get(d.id) ?? 0;
    const auto = d.autoRefreshEnabled ? "auto-refresh ON" : "auto-refresh off";
    return `- ${d.name} (slug=${d.slug}, id=${d.id}) — ${wc} widget(s), ${auto}`;
  });
  return `Dashboards (${all.length}):\n${lines.join("\n")}\n\nView any in the web UI at /dashboards?slug=<slug>.`;
}

export async function execGetDashboard(args: { id?: string; slug?: string }): Promise<string> {
  const dashboard = findDashboardByIdOrSlug(args);
  if (!dashboard) return `ERROR: Dashboard not found (id=${args.id}, slug=${args.slug})`;
  const widgets = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboard.id))
    .orderBy(asc(dashboardWidgets.gridY), asc(dashboardWidgets.gridX), asc(dashboardWidgets.createdAt))
    .all();

  const lines = [
    `Dashboard: ${dashboard.name} (slug=${dashboard.slug}, id=${dashboard.id})`,
    `Description: ${dashboard.description || "(none)"}`,
    `Auto-refresh: ${dashboard.autoRefreshEnabled ? "ON" : "off"}`,
    `URL: /dashboards?slug=${dashboard.slug}`,
    `Widgets: ${widgets.length}`,
  ];
  for (const w of widgets) {
    const blocks = safeParseJson<CanvasBlock[]>(w.blocks, []);
    const types = blocks.map((b) => b.type).join(", ");
    const refresh =
      w.refresherKind == null
        ? "frozen"
        : w.refreshIntervalMinutes != null
          ? `${w.refresherKind}, every ${w.refreshIntervalMinutes}m`
          : `${w.refresherKind} (manual)`;
    lines.push(
      `  • ${w.title} (id=${w.id}) — gridW=${w.gridW}, blocks=[${types || "empty"}], ${refresh}`,
    );
  }
  return lines.join("\n");
}

// ── Dashboard CRUD ─────────────────────────────────────────────────────

export async function execCreateDashboard(args: {
  name?: string;
  description?: string;
  autoRefreshEnabled?: boolean;
}): Promise<string> {
  if (!args.name || typeof args.name !== "string") {
    return "ERROR: name is required";
  }
  const finalSlug = ensureUniqueSlug(slugify(args.name));
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(dashboards)
    .values({
      id,
      name: args.name,
      slug: finalSlug,
      description: args.description ?? "",
      autoRefreshEnabled: args.autoRefreshEnabled ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return `Created dashboard "${args.name}" (slug=${finalSlug}, id=${id}). View at /dashboards?slug=${finalSlug}.`;
}

export async function execUpdateDashboard(args: {
  id?: string;
  name?: string;
  description?: string;
  autoRefreshEnabled?: boolean;
}): Promise<string> {
  if (!args.id) return "ERROR: id is required";
  const existing = db.select().from(dashboards).where(eq(dashboards.id, args.id)).get();
  if (!existing) return `ERROR: Dashboard not found (id=${args.id})`;
  db.update(dashboards)
    .set({
      ...(typeof args.name === "string" && { name: args.name }),
      ...(typeof args.description === "string" && { description: args.description }),
      ...(typeof args.autoRefreshEnabled === "boolean" && { autoRefreshEnabled: args.autoRefreshEnabled }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dashboards.id, args.id))
    .run();
  const updated = db.select().from(dashboards).where(eq(dashboards.id, args.id)).get()!;
  return `Updated dashboard "${updated.name}" (slug=${updated.slug}). Auto-refresh: ${updated.autoRefreshEnabled ? "ON" : "off"}.`;
}

export async function execDeleteDashboard(args: { id?: string }): Promise<string> {
  if (!args.id) return "ERROR: id is required";
  const existing = db.select().from(dashboards).where(eq(dashboards.id, args.id)).get();
  if (!existing) return `ERROR: Dashboard not found (id=${args.id})`;
  db.delete(dashboards).where(eq(dashboards.id, args.id)).run();
  return `Deleted dashboard "${existing.name}" and its widgets.`;
}

// ── Widget CRUD ────────────────────────────────────────────────────────

function isCanvasBlock(x: unknown): x is CanvasBlock {
  return !!x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string";
}

export async function execCreateWidget(args: {
  dashboardId?: string;
  dashboardSlug?: string;
  title?: string;
  blocks?: unknown;
  gridW?: number;
  gridH?: number;
}): Promise<string> {
  const dashboard = findDashboardByIdOrSlug({
    id: args.dashboardId,
    slug: args.dashboardSlug,
  });
  if (!dashboard) {
    return `ERROR: Dashboard not found (provide dashboardId or dashboardSlug)`;
  }
  if (!args.title || typeof args.title !== "string") {
    return "ERROR: title is required";
  }
  if (!Array.isArray(args.blocks) || args.blocks.length === 0) {
    return "ERROR: blocks must be a non-empty array of canvas-block objects";
  }
  const blocks = args.blocks.filter(isCanvasBlock);
  if (blocks.length === 0) {
    return "ERROR: blocks must contain at least one object with a string 'type' field";
  }

  const widgetId = randomUUID();
  const now = new Date().toISOString();
  db.insert(dashboardWidgets)
    .values({
      id: widgetId,
      dashboardId: dashboard.id,
      title: args.title,
      blocks: JSON.stringify(blocks),
      sourceMessageId: null,
      gridX: 0,
      gridY: nextWidgetY(dashboard.id),
      gridW: typeof args.gridW === "number" ? Math.max(1, Math.min(3, args.gridW)) : 1,
      gridH: typeof args.gridH === "number" ? Math.max(1, args.gridH) : 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return `Created widget "${args.title}" (id=${widgetId}) on dashboard "${dashboard.name}". Frozen — set a refresher with chomp_set_widget_refresher if it should refresh.`;
}

export async function execUpdateWidget(args: {
  id?: string;
  title?: string;
  blocks?: unknown;
  gridX?: number;
  gridY?: number;
  gridW?: number;
  gridH?: number;
}): Promise<string> {
  if (!args.id) return "ERROR: id is required";
  const existing = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, args.id)).get();
  if (!existing) return `ERROR: Widget not found (id=${args.id})`;

  let nextBlocks: CanvasBlock[] | null = null;
  if (args.blocks !== undefined) {
    if (!Array.isArray(args.blocks) || args.blocks.length === 0) {
      return "ERROR: blocks must be a non-empty array of canvas-block objects";
    }
    nextBlocks = args.blocks.filter(isCanvasBlock);
    if (nextBlocks.length === 0) {
      return "ERROR: blocks must contain at least one object with a string 'type' field";
    }
  }

  db.update(dashboardWidgets)
    .set({
      ...(typeof args.title === "string" && { title: args.title }),
      ...(nextBlocks && { blocks: JSON.stringify(nextBlocks) }),
      ...(typeof args.gridX === "number" && { gridX: args.gridX }),
      ...(typeof args.gridY === "number" && { gridY: args.gridY }),
      ...(typeof args.gridW === "number" && { gridW: Math.max(1, Math.min(3, args.gridW)) }),
      ...(typeof args.gridH === "number" && { gridH: Math.max(1, args.gridH) }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dashboardWidgets.id, args.id))
    .run();
  const updated = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, args.id)).get()!;
  return `Updated widget "${updated.title}" (id=${updated.id}).`;
}

export async function execDeleteWidget(args: { id?: string }): Promise<string> {
  if (!args.id) return "ERROR: id is required";
  const existing = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, args.id)).get();
  if (!existing) return `ERROR: Widget not found (id=${args.id})`;
  db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, args.id)).run();
  return `Deleted widget "${existing.title}".`;
}

// ── Refresher ──────────────────────────────────────────────────────────

export async function execSetWidgetRefresher(args: {
  id?: string;
  kind?: "template" | "agent" | "skill" | "prompt" | null;
  payload?: Record<string, unknown> | null;
  schema?: unknown;
  refreshIntervalMinutes?: number | null;
}): Promise<string> {
  if (!args.id) return "ERROR: id is required";
  const existing = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, args.id)).get();
  if (!existing) return `ERROR: Widget not found (id=${args.id})`;

  const kind = args.kind ?? null;
  if (kind === "skill" || kind === "prompt") {
    return `ERROR: kind "${kind}" was retired in Phase 7. Use "template" (URL + transform recipe) or "agent" (claude -p fallback) instead.`;
  }
  if (kind !== null && kind !== "template" && kind !== "agent") {
    return `ERROR: kind must be 'template', 'agent', or null`;
  }
  if (kind !== null && (!args.payload || typeof args.payload !== "object")) {
    return "ERROR: payload required when kind is not null";
  }
  if (kind === "template") {
    const p = args.payload as Record<string, unknown>;
    const hasSingleUrl = typeof p.url === "string" && p.url.length > 0;
    const hasRequests =
      p.requests !== null &&
      typeof p.requests === "object" &&
      !Array.isArray(p.requests) &&
      Object.keys(p.requests).length > 0;
    if (!hasSingleUrl && !hasRequests) {
      return "ERROR: template-kind payload requires 'url' or non-empty 'requests'";
    }
    if (hasRequests) {
      for (const [key, request] of Object.entries(p.requests as Record<string, unknown>)) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          return `ERROR: template-kind request "${key}" must be an object`;
        }
        const url = (request as Record<string, unknown>).url;
        if (typeof url !== "string" || url.length === 0) {
          return `ERROR: template-kind request "${key}" requires 'url'`;
        }
      }
    }
    if (p.transform === undefined || p.transform === null) {
      return "ERROR: template-kind payload requires 'transform' (canvas-block template)";
    }
    try {
      const { validateTemplateSyntax } = await import("../widget-refresh-template.js");
      validateTemplateSyntax(p.transform);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : "template syntax error"}`;
    }
  }
  if (kind === "agent") {
    const p = args.payload as Record<string, unknown>;
    if (typeof p.prompt !== "string" || p.prompt.length === 0) {
      return "ERROR: agent-kind payload requires 'prompt'";
    }
  }

  let nextInterval: number | null = existing.refreshIntervalMinutes ?? null;
  if (args.refreshIntervalMinutes === null) {
    nextInterval = null;
  } else if (typeof args.refreshIntervalMinutes === "number" && args.refreshIntervalMinutes >= 1) {
    nextInterval = Math.floor(args.refreshIntervalMinutes);
  }
  if (kind === null) nextInterval = null;

  db.update(dashboardWidgets)
    .set({
      refresherKind: kind,
      refresherPayload: kind === null ? null : JSON.stringify(args.payload),
      refreshIntervalMinutes: nextInterval,
      ...(Array.isArray(args.schema) && { schemaJson: JSON.stringify(args.schema) }),
      lastClassifyError: null,
      classifying: false,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(dashboardWidgets.id, args.id))
    .run();

  const summary =
    kind === null
      ? "frozen (no refresh)"
      : nextInterval !== null
        ? `${kind}, auto-refresh every ${nextInterval}m (gated by dashboard's auto-refresh switch)`
        : `${kind}, manual refresh only`;
  return `Refresher set for "${existing.title}": ${summary}.`;
}
