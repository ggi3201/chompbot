import { randomUUID } from "crypto";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { incidentEvents, incidents, incidentTargets } from "../db/schema.js";
import { emit } from "../events/bus.js";
import { notifyIncident, type IncidentNotice } from "./alerts.js";
import { OUTSIDE_PREFIX } from "./incident-views.js";
import type { Status, Target } from "./schedule.js";
import { activeTargets, getTarget } from "./store.js";

export { getIncident, listIncidents, openIncidentCount, type IncidentDetail, type IncidentRow } from "./incident-views.js";

/** A target must stay down this long before its incident opens, so the services of one outage open one incident. */
export const OPEN_DELAY_MS = 60_000;
export const FLAP_WINDOW_MS = 30 * 60_000;
export const FLAP_CHANGES = 4;
/** An incident that flapped stays open, and silent, until nothing has changed for this long. */
export const STABLE_MS = 15 * 60_000;
/** A dependency that is not a target of its own (Traefik, the tunnel) counts as down when this many services behind it are, and all of them are. */
const DERIVED_MIN_DEPENDENTS = 2;

/** Event kinds that are a change of the incident's state: it went down, or came all the way back. These make a flap. */
const CHANGE_KINDS = ["opened", "reopened", "recovered"];

export type Vantage = "home" | "outside";
export interface StatusChange {
  vantage: Vantage;
  status: Status;
  error: string | null;
}

/** When each target was first seen down and not yet in an incident, by vantage and key. A restart restarts the wait. */
const downSince = new Map<string, number>();

/** Forgets which targets were waiting to open an incident. For tests. */
export const forgetPendingIncidents = () => downSince.clear();

const iso = (ms: number) => new Date(ms).toISOString();
const minutesBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

const addEvent = (incidentId: string, ts: string, kind: string, text: string | null) =>
  db.insert(incidentEvents).values({ incidentId, ts, kind, text }).run();

const getRow = (incidentId: string) => db.select().from(incidents).where(eq(incidents.id, incidentId)).get()!;

const isOutsideCause = (causeKey: string) => causeKey.startsWith(OUTSIDE_PREFIX);

/** The open incident this target is down in. Outside-probe incidents are kept apart from the others. */
function openRowFor(targetKey: string, outside: boolean) {
  return db.select({ incidentId: incidentTargets.incidentId, causeKey: incidents.causeKey }).from(incidentTargets)
    .innerJoin(incidents, eq(incidents.id, incidentTargets.incidentId))
    .where(and(eq(incidentTargets.targetKey, targetKey), isNull(incidentTargets.upAt), eq(incidents.state, "open")))
    .all().find((row) => isOutsideCause(row.causeKey) === outside);
}

const anyDown = (incidentId: string) =>
  !!db.select().from(incidentTargets).where(and(eq(incidentTargets.incidentId, incidentId), isNull(incidentTargets.upAt))).get();

// ── Cause ───────────────────────────────────────────────────────────────

function isDown(dependency: string): boolean {
  const known = getTarget(dependency);
  if (known) return !known.retiredAt && known.status === "down";
  const dependents = activeTargets().filter((t) => t.tracked && t.dependsOn.includes(dependency));
  return dependents.length >= DERIVED_MIN_DEPENDENTS && dependents.every((t) => t.status === "down");
}

/** The highest thing that is down: the host first, then Traefik or the tunnel, then the service itself. `dependsOn` lists them in that order. */
const causeOf = (target: Pick<Target, "key" | "dependsOn">) => target.dependsOn.find(isDown) ?? target.key;

function titleOfCause(causeKey: string): string {
  if (causeKey === "infra:traefik") return "Traefik is down";
  if (causeKey === "infra:tunnel") return "Cloudflare tunnel is down";
  const known = getTarget(causeKey);
  if (known) return `${known.title} is down`;
  const host = /^host:(.+)$/.exec(causeKey);
  return host ? `Everything on ${host[1]} is down` : `${causeKey} is down`;
}

// ── Entry points ────────────────────────────────────────────────────────

/**
 * Moves incidents with one target's status. `change.status` is the target's settled status for that vantage,
 * already past the down and up rules (3 failures, 2 passes), so a caller reports each result it gets.
 *
 * - Only tracked targets open incidents. A target that is down is held for OPEN_DELAY_MS first, so the cause is known.
 * - From "home", the cause is the highest dependency that is down; from "outside" it is the target, and only while home is up.
 * - A target that goes up closes its part of the incident. When no target is down the incident is over.
 */
export function applyStatusChange(target: Pick<Target, "key">, change: StatusChange, now: number): void {
  const row = getTarget(target.key);
  if (!row) return;
  const outside = change.vantage === "outside";
  const waitKey = `${change.vantage}:${row.key}`;

  if (change.status === "up") {
    downSince.delete(waitKey);
    recoverTarget(row, outside, now);
    return;
  }
  if (change.status !== "down") return;
  // An outside failure only counts when home can reach the service. Otherwise the home incident tells the story.
  if (!row.tracked || openRowFor(row.key, outside) || (outside && row.status !== "up")) {
    downSince.delete(waitKey);
    return;
  }
  // The outside verdict comes already debounced and has no siblings to group with, so only home waits a cycle.
  if (outside) {
    attach(`${OUTSIDE_PREFIX}${row.key}`, row, change.error, now);
    return;
  }
  const since = downSince.get(waitKey) ?? now;
  downSince.set(waitKey, since);
  if (now - since < OPEN_DELAY_MS) return;
  downSince.delete(waitKey);
  attach(causeOf(row), row, change.error, now);
}

/** A home check result for a target. */
export const syncIncident = (target: Pick<Target, "key">, status: Status, error: string | null, now: number) =>
  applyStatusChange(target, { vantage: "home", status, error }, now);

/** A target that is gone, or no longer tracked, cannot recover or alert, so its open incidents end with it. */
export function closeIncidentOf(targetKey: string, now: number, why = "is gone"): void {
  for (const outside of [false, true]) {
    const open = openRowFor(targetKey, outside);
    if (!open) continue;
    const ts = iso(now);
    const title = getTarget(targetKey)?.title ?? targetKey;
    db.update(incidentTargets).set({ upAt: ts })
      .where(and(eq(incidentTargets.incidentId, open.incidentId), eq(incidentTargets.targetKey, targetKey))).run();
    addEvent(open.incidentId, ts, "retired", `${title} ${why}`);
    if (!anyDown(open.incidentId)) resolve(open.incidentId, now, `Closed: ${title} ${why}`);
  }
}

/** A host threshold was crossed (phase 3's disk and memory warnings). One incident per host and kind, without services. */
export function openHostIncident(host: string, kind: string, text: string, now: number): string {
  const causeKey = `host:${host}:${kind}`;
  const open = db.select().from(incidents).where(and(eq(incidents.causeKey, causeKey), eq(incidents.state, "open"))).get();
  if (open) return open.id;
  return openIncident(causeKey, text, null, text, now);
}

/** The host is back under its threshold. Returns false when no such incident was open. */
export function resolveHostIncident(host: string, kind: string, now: number): boolean {
  const open = db.select().from(incidents).where(and(eq(incidents.causeKey, `host:${host}:${kind}`), eq(incidents.state, "open"))).get();
  if (!open) return false;
  resolve(open.id, now, `Recovered after ${minutesBetween(open.startedAt, iso(now))} min`);
  return true;
}

/**
 * Time-based upkeep, run every tick: an incident that flapped and has not changed for STABLE_MS
 * speaks again, and ends if every service is up.
 */
export function settleIncidents(now: number): void {
  const flapping = db.select().from(incidents).where(and(eq(incidents.state, "open"), eq(incidents.flapping, true))).all();
  for (const incident of flapping) {
    const last = db.select({ ts: incidentEvents.ts }).from(incidentEvents)
      .where(and(eq(incidentEvents.incidentId, incident.id), inArray(incidentEvents.kind, CHANGE_KINDS)))
      .orderBy(desc(incidentEvents.ts)).limit(1).get()?.ts ?? incident.startedAt;
    if (now - Date.parse(last) < STABLE_MS) continue;
    db.update(incidents).set({ flapping: false }).where(eq(incidents.id, incident.id)).run();
    addEvent(incident.id, iso(now), "stable", `Nothing changed for ${STABLE_MS / 60_000} min`);
    if (anyDown(incident.id)) notifyIncident(incident.id, "stable", now);
    else resolve(incident.id, now, `Recovered after ${minutesBetween(incident.startedAt, iso(now))} min`);
  }
}

// ── Opening and joining ─────────────────────────────────────────────────

function openIncident(causeKey: string, title: string, target: Pick<Target, "key"> | null, error: string | null, now: number): string {
  const id = randomUUID();
  const ts = iso(now);
  db.insert(incidents).values({ id, title, causeKey, startedAt: ts }).run();
  if (target) db.insert(incidentTargets).values({ incidentId: id, targetKey: target.key, downAt: ts }).run();
  addEvent(id, ts, "opened", error);
  emit({ type: "monitoring.incident.opened", incidentId: id, title, causeKey, targetKeys: target ? [target.key] : [] });
  notifyIncident(id, "opened", now);
  return id;
}

/** A target is down for this cause: open the cause's incident, bring back one that just ended, or join the open one. */
function attach(causeKey: string, target: Target, error: string | null, now: number): void {
  const ts = iso(now);
  const open = db.select().from(incidents).where(and(eq(incidents.causeKey, causeKey), eq(incidents.state, "open"))).get();
  const recent = open ?? db.select().from(incidents)
    .where(and(eq(incidents.causeKey, causeKey), eq(incidents.state, "resolved"), gte(incidents.endedAt, iso(now - STABLE_MS))))
    .orderBy(desc(incidents.endedAt)).limit(1).get();
  if (!recent) {
    const title = isOutsideCause(causeKey) ? `${target.title} unreachable from outside` : titleOfCause(causeKey);
    openIncident(causeKey, title, target, error, now);
    return;
  }

  const wasAllUp = !anyDown(recent.id);
  db.insert(incidentTargets).values({ incidentId: recent.id, targetKey: target.key, downAt: ts })
    .onConflictDoUpdate({ target: [incidentTargets.incidentId, incidentTargets.targetKey], set: { downAt: ts, upAt: null } }).run();
  if (recent.state === "resolved") db.update(incidents).set({ state: "open", endedAt: null }).where(eq(incidents.id, recent.id)).run();

  const text = `${target.title}: ${error ?? "down"}`;
  if (wasAllUp) {
    addEvent(recent.id, ts, "reopened", text);
    announce(recent.id, "reopened", now);
  } else {
    addEvent(recent.id, ts, "joined", text);
    announce(recent.id, "changed", now);
  }
}

/** Sends the notice, or "flapping" instead when this change made the incident flap. */
function announce(incidentId: string, notice: IncidentNotice, now: number): void {
  notifyIncident(incidentId, markFlapping(incidentId, now) ? "flapping" : notice, now);
}

/** Marks the incident as flapping when it changed state FLAP_CHANGES times in FLAP_WINDOW_MS. True when it just started. */
function markFlapping(incidentId: string, now: number): boolean {
  if (getRow(incidentId).flapping) return false;
  const changes = db.select().from(incidentEvents)
    .where(and(eq(incidentEvents.incidentId, incidentId), inArray(incidentEvents.kind, CHANGE_KINDS), gte(incidentEvents.ts, iso(now - FLAP_WINDOW_MS)))).all();
  if (changes.length < FLAP_CHANGES) return false;
  db.update(incidents).set({ flapping: true }).where(eq(incidents.id, incidentId)).run();
  addEvent(incidentId, iso(now), "flapping", `${changes.length} state changes in ${FLAP_WINDOW_MS / 60_000} min. No messages until it is stable for ${STABLE_MS / 60_000} min.`);
  return true;
}

// ── Recovering and closing ──────────────────────────────────────────────

function recoverTarget(target: Target, outside: boolean, now: number): void {
  const open = openRowFor(target.key, outside);
  if (!open) return;
  const ts = iso(now);
  db.update(incidentTargets).set({ upAt: ts })
    .where(and(eq(incidentTargets.incidentId, open.incidentId), eq(incidentTargets.targetKey, target.key))).run();
  if (anyDown(open.incidentId)) {
    addEvent(open.incidentId, ts, "up", `${target.title} is up again`);
    notifyIncident(open.incidentId, "changed", now);
    return;
  }
  addEvent(open.incidentId, ts, "recovered", `${target.title} is up again`);
  if (markFlapping(open.incidentId, now)) {
    notifyIncident(open.incidentId, "flapping", now);
    return;
  }
  if (!getRow(open.incidentId).flapping) resolve(open.incidentId, now, `Recovered after ${minutesBetween(getRow(open.incidentId).startedAt, ts)} min`);
}

function resolve(incidentId: string, now: number, text: string): void {
  const ts = iso(now);
  const incident = getRow(incidentId);
  db.update(incidents).set({ state: "resolved", endedAt: ts, flapping: false }).where(eq(incidents.id, incidentId)).run();
  addEvent(incidentId, ts, "resolved", text);
  emit({ type: "monitoring.incident.resolved", incidentId, title: incident.title, durationMs: Math.max(0, now - Date.parse(incident.startedAt)) });
  notifyIncident(incidentId, "resolved", now);
}
