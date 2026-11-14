import { count, desc, eq, gte, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { incidentEvents, incidents, incidentTargets, monitorTargets } from "../db/schema.js";

const DAY_MS = 86_400_000;

export type DiagnosisStatus = "none" | "running" | "done" | "failed";

/** Incidents whose diagnosis is running in this process. A restart forgets them, and the page then shows "failed". */
const diagnosing = new Set<string>();
export const isDiagnosing = (incidentId: string) => diagnosing.has(incidentId);
/** Claims the incident's diagnosis slot. False when a diagnosis already holds it. */
export function claimDiagnosis(incidentId: string): boolean {
  if (diagnosing.has(incidentId)) return false;
  diagnosing.add(incidentId);
  return true;
}
export const releaseDiagnosis = (incidentId: string) => diagnosing.delete(incidentId);

export const OUTSIDE_PREFIX = "outside:";

/** What the incident blames, in words: the failing service, a host, Traefik, the tunnel, or the outside probe. */
export function causeLabel(causeKey: string): string {
  if (causeKey === "infra:traefik") return "Traefik";
  if (causeKey === "infra:tunnel") return "Cloudflare tunnel";
  if (causeKey.startsWith(OUTSIDE_PREFIX)) return `${targetTitle(causeKey.slice(OUTSIDE_PREFIX.length))} from outside`;
  const host = /^host:([^:]+)(?::(.+))?$/.exec(causeKey);
  if (host) return host[2] ? `${host[1]} ${host[2]}` : host[1];
  return targetTitle(causeKey);
}

function targetTitle(key: string): string {
  return db.select({ title: monitorTargets.title }).from(monitorTargets).where(eq(monitorTargets.key, key)).get()?.title ?? key;
}

export const openIncidentCount = () =>
  db.select({ n: count() }).from(incidents).where(eq(incidents.state, "open")).get()?.n ?? 0;

export interface IncidentRow {
  id: string;
  title: string;
  causeKey: string;
  /** causeKey in words. */
  cause: string;
  state: "open" | "resolved";
  flapping: boolean;
  startedAt: string;
  endedAt: string | null;
  /** Why it opened: the error of the first failing check. */
  msg: string | null;
  targets: { key: string; title: string }[];
  diagnosis: DiagnosisStatus;
}

export interface IncidentEvent { id: number; ts: string; kind: string; text: string | null }

export interface IncidentDetail extends IncidentRow {
  conversationId: string | null;
  telegramMessageId: number | null;
  targets: { key: string; title: string; downAt: string; upAt: string | null }[];
  events: IncidentEvent[];
  /** The latest diagnosis, if one finished. */
  diagnosisText: string | null;
}

function diagnosisStatusOf(incidentId: string, events: readonly Pick<IncidentEvent, "kind">[]): DiagnosisStatus {
  if (isDiagnosing(incidentId)) return "running";
  const last = events.filter((e) => e.kind.startsWith("diagnosis")).at(-1);
  if (!last) return "none";
  return last.kind === "diagnosis" ? "done" : "failed";
}

const eventsOf = (ids: string[]) =>
  db.select().from(incidentEvents).where(inArray(incidentEvents.incidentId, ids)).orderBy(incidentEvents.ts, incidentEvents.id).all();

const targetsOf = (ids: string[]) =>
  db.select({ incidentId: incidentTargets.incidentId, key: incidentTargets.targetKey, title: monitorTargets.title, downAt: incidentTargets.downAt, upAt: incidentTargets.upAt })
    .from(incidentTargets).leftJoin(monitorTargets, eq(monitorTargets.key, incidentTargets.targetKey))
    .where(inArray(incidentTargets.incidentId, ids)).orderBy(incidentTargets.downAt).all();

type IncidentDbRow = typeof incidents.$inferSelect;

function rowOf(row: IncidentDbRow, events: IncidentEvent[], targets: ReturnType<typeof targetsOf>): IncidentRow {
  return {
    id: row.id,
    title: row.title,
    causeKey: row.causeKey,
    cause: causeLabel(row.causeKey),
    state: row.state,
    flapping: row.flapping,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    msg: events.find((event) => event.kind === "opened")?.text ?? null,
    targets: targets.map((t) => ({ key: t.key, title: t.title ?? t.key })),
    diagnosis: diagnosisStatusOf(row.id, events),
  };
}

/** Open incidents, however old, and resolved ones from the last `days` days. Newest first. */
export function listIncidents({ now = Date.now(), days = 30, limit = 50 } = {}): IncidentRow[] {
  const since = new Date(now - days * DAY_MS).toISOString();
  const rows = db.select().from(incidents)
    .where(or(eq(incidents.state, "open"), gte(incidents.endedAt, since)))
    .orderBy(desc(incidents.startedAt)).limit(limit).all();
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const events = eventsOf(ids);
  const targets = targetsOf(ids);
  return rows.map((row) => rowOf(row, events.filter((e) => e.incidentId === row.id), targets.filter((t) => t.incidentId === row.id)));
}

export function getIncident(id: string): IncidentDetail | undefined {
  const row = db.select().from(incidents).where(eq(incidents.id, id)).get();
  if (!row) return undefined;
  const events = eventsOf([id]);
  const targets = targetsOf([id]);
  return {
    ...rowOf(row, events, targets),
    conversationId: row.conversationId,
    telegramMessageId: row.telegramMessageId,
    targets: targets.map((t) => ({ key: t.key, title: t.title ?? t.key, downAt: t.downAt, upAt: t.upAt })),
    events: events.map(({ id: eventId, ts, kind, text }) => ({ id: eventId, ts, kind, text })),
    diagnosisText: events.filter((e) => e.kind === "diagnosis").at(-1)?.text ?? null,
  };
}
