// Polls every 60s for widgets whose parent dashboard has auto_refresh_enabled
// AND whose own refresh_interval_minutes is past due. Calls the API's internal
// refresh endpoint (no auth, localhost only) — never spawns LLM work in this
// process. Cost gating lives entirely on the dashboard.auto_refresh_enabled
// flag — both flags must be set for a widget to be considered due.

import { internalAuth } from "./internal-auth.js";
import { db } from "./db.js";
import { dashboards, dashboardWidgets, activityLog } from "./schema.js";
import { eq, isNotNull } from "drizzle-orm";
import { randomUUID } from "crypto";

const API_URL = process.env.API_URL ?? "http://localhost:3001";

const TICK_INTERVAL_MS = 60 * 1000;

interface DueWidget {
  id: string;
  dashboardId: string;
  refreshIntervalMinutes: number;
  lastRefreshedAt: string | null;
}

function isDue(widget: DueWidget, now: number): boolean {
  if (!widget.lastRefreshedAt) return true;
  const last = new Date(widget.lastRefreshedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= widget.refreshIntervalMinutes * 60 * 1000;
}

async function tick() {
  const enabledDashboardIds = new Set(
    db
      .select({ id: dashboards.id })
      .from(dashboards)
      .where(eq(dashboards.autoRefreshEnabled, true))
      .all()
      .map((r) => r.id),
  );
  if (enabledDashboardIds.size === 0) return;

  const candidates = db
    .select({
      id: dashboardWidgets.id,
      dashboardId: dashboardWidgets.dashboardId,
      refresherKind: dashboardWidgets.refresherKind,
      refreshIntervalMinutes: dashboardWidgets.refreshIntervalMinutes,
      lastRefreshedAt: dashboardWidgets.lastRefreshedAt,
    })
    .from(dashboardWidgets)
    .where(isNotNull(dashboardWidgets.refreshIntervalMinutes))
    .all();

  const now = Date.now();
  const due: DueWidget[] = [];
  for (const w of candidates) {
    if (!w.refresherKind) continue;
    if (typeof w.refreshIntervalMinutes !== "number") continue;
    if (!enabledDashboardIds.has(w.dashboardId)) continue;
    const dw: DueWidget = {
      id: w.id,
      dashboardId: w.dashboardId,
      refreshIntervalMinutes: w.refreshIntervalMinutes,
      lastRefreshedAt: w.lastRefreshedAt,
    };
    if (isDue(dw, now)) due.push(dw);
  }

  if (due.length === 0) return;
  console.log(`[widget-refresh-tick] ${due.length} widget(s) due`);

  const results = await Promise.allSettled(
    due.map(async (w) => {
      const resp = await fetch(`${API_URL}/api/internal/refresh-widget/${w.id}`, { method: "POST", headers: internalAuth });
      const body = (await resp.json().catch(() => ({}))) as { error?: string };
      return { id: w.id, ok: resp.ok, status: resp.status, error: body.error };
    }),
  );

  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      succeeded += 1;
    } else {
      failed += 1;
      const detail =
        r.status === "fulfilled"
          ? `HTTP ${r.value.status} ${r.value.error ?? ""}`
          : (r.reason instanceof Error ? r.reason.message : String(r.reason));
      console.warn(`[widget-refresh-tick] failed:`, detail);
    }
  }

  if (succeeded + failed > 0) {
    db.insert(activityLog)
      .values({
        id: randomUUID(),
        type: "widget-auto-refresh",
        summary: `Auto-refreshed ${succeeded}/${succeeded + failed} widget(s)`,
        details: JSON.stringify({ succeeded, failed, total: due.length }),
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}

export function startWidgetRefreshTick() {
  console.log(`[widget-refresh-tick] Starting with ${TICK_INTERVAL_MS / 1000}s interval`);
  tick().catch((err) => console.error("[widget-refresh-tick] Initial tick error:", err));
  setInterval(() => {
    tick().catch((err) => console.error("[widget-refresh-tick] Tick error:", err));
  }, TICK_INTERVAL_MS);
}
