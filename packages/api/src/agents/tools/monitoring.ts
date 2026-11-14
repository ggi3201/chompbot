import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { incidentEvents, monitorChecks } from "../../db/schema.js";
import { openIncidentOf, readLogs } from "../../monitoring/actions.js";
import { listIncidents } from "../../monitoring/incidents.js";
import { buildOverview, buildTargetRows, openWarnings, type TargetRow } from "../../monitoring/views.js";

const RECENT_CHECKS = 10;
const INCIDENT_EVENTS = 8;
const DEFAULT_INCIDENTS = 20;
const MAX_INCIDENTS = 50;

const json = (value: unknown) => JSON.stringify(value, null, 2);
const iso = (ms: number) => new Date(ms).toISOString();

const wordsOf = (row: TargetRow) => [row.key, row.title, row.host, row.project, row.container, row.unit].filter(Boolean).join(" ").toLowerCase();
const matches = (row: TargetRow, query: string) => wordsOf(row).includes(query.toLowerCase());

const brief = (row: TargetRow) => ({
  key: row.key, title: row.title, host: row.host, project: row.project, since: row.statusSince, message: row.message,
});

/** What is wrong right now: tracked services that are down or have gone quiet, open incidents, and the open warnings. */
export function execMonitoringStatus(args: { query?: unknown }, now = Date.now()): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const all = buildTargetRows(now);
  const rows = query ? all.filter((row) => matches(row, query)) : all;
  const { counts, checkedAt } = buildOverview(rows, now);
  const keys = new Set(rows.map((row) => row.key));
  const inScope = (row: TargetRow) => row.tracked && !row.hidden && !row.retired;
  const down = rows.filter((row) => inScope(row) && row.state === "down");
  const stale = rows.filter((row) => inScope(row) && row.state === "stale");
  const incidents = listIncidents({ now }).filter((i) => i.state === "open" && (!query || i.targets.some((t) => keys.has(t.key))));
  const warnings = openWarnings().filter((w) => !query || (w.targetKey !== null && keys.has(w.targetKey)));
  const verdict = [down.length && `${down.length} down`, stale.length && `${stale.length} without a recent check`].filter(Boolean).join(", ") || "all up";
  return json({
    verdict,
    ...(query && { query }),
    checkedAt,
    counts,
    down: down.map(brief),
    stale: stale.map(brief),
    openIncidents: incidents.map(({ id, title, startedAt, msg, targets }) => ({ id, title, startedAt, msg, targets: targets.map((t) => t.key) })),
    warnings: warnings.map(({ key, kind, targetKey, text, firstSeen, critical }) => ({ key, kind, targetKey, text, firstSeen, critical })),
  });
}

/** The row for a key or a name. A name that matches several rows is an error that lists them. */
function findRow(rows: TargetRow[], name: string): TargetRow | string {
  const wanted = name.trim().toLowerCase();
  const live = rows.filter((row) => !row.retired);
  const exact = live.find((row) => row.key.toLowerCase() === wanted) ?? rows.find((row) => row.key.toLowerCase() === wanted);
  if (exact) return exact;
  const titled = live.filter((row) => row.title.toLowerCase() === wanted);
  const found = titled.length ? titled : live.filter((row) => matches(row, wanted));
  if (found.length === 1) return found[0];
  if (!found.length) return `ERROR: No monitored service matches "${name}". Try monitoring_status for the list.`;
  return `ERROR: ${found.length} services match "${name}". Ask again with one key: ${found.slice(0, 10).map((row) => row.key).join(", ")}`;
}

function recentChecks(targetKey: string) {
  return db.select().from(monitorChecks).where(eq(monitorChecks.targetKey, targetKey))
    .orderBy(desc(monitorChecks.ts), desc(monitorChecks.id)).limit(RECENT_CHECKS).all()
    .map((c) => ({ at: iso(c.ts), vantage: c.vantage, ok: c.ok, statusCode: c.statusCode, latencyMs: c.latencyMs, error: c.error }));
}

function openIncidentWithEvents(targetKey: string) {
  const incident = openIncidentOf(targetKey);
  if (!incident) return null;
  const events = db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, incident.id))
    .orderBy(desc(incidentEvents.ts), desc(incidentEvents.id)).limit(INCIDENT_EVENTS).all().reverse();
  return { ...incident, events: events.map(({ ts, kind, text }) => ({ ts, kind, text })) };
}

/** One service: what it is, who can reach it, its latest checks and open incident, and optionally the tail of its log. */
export async function execMonitoringTarget(args: { target?: unknown; logs?: unknown }, now = Date.now()): Promise<string> {
  if (typeof args.target !== "string" || !args.target.trim()) return "ERROR: target required (a key such as mini:8080, or a name)";
  const row = findRow(buildTargetRows(now), args.target);
  if (typeof row === "string") return row;

  let logs: unknown;
  if (args.logs === true) {
    try {
      logs = await readLogs(row.key);
    } catch (err) {
      logs = { error: err instanceof Error ? err.message : "Could not read the log" };
    }
  }
  const { days: _days, ...facts } = row;
  return json({
    ...facts,
    recentChecks: recentChecks(row.key),
    openIncident: openIncidentWithEvents(row.key),
    ...(logs !== undefined && { logs }),
  });
}

/** Recent incidents, newest first: open ones and those resolved in the last 30 days. */
export function execMonitoringIncidents(args: { open_only?: unknown; limit?: unknown }, now = Date.now()): string {
  const limit = Math.min(MAX_INCIDENTS, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_INCIDENTS));
  const incidents = listIncidents({ now, limit: MAX_INCIDENTS }).filter((i) => args.open_only !== true || i.state === "open").slice(0, limit);
  return json({ incidents });
}
