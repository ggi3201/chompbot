import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { db } from "../../src/db/index.js";
import {
  hostMetricRollups, hostMetrics, incidentEvents, incidents, incidentTargets, monitorChecks, monitorRollups, monitorTargets, monitorWarnings,
} from "../../src/db/schema.js";
import { resetAlertState } from "../../src/monitoring/alerts.js";
import { forgetPendingIncidents, syncIncident } from "../../src/monitoring/incidents.js";
import { createTarget, type NewTarget } from "../../src/monitoring/store.js";

export const NOW = Date.parse("2026-11-08T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function clearMonitoring() {
  forgetPendingIncidents();
  resetAlertState();
  for (const table of [incidentEvents, incidentTargets, incidents, monitorRollups, monitorChecks, monitorTargets, monitorWarnings, hostMetrics, hostMetricRollups]) db.delete(table).run();
}

/** Down for one check cycle, so the incident engine's hold is over and the incident is open at `now`. */
export function downForACycle(target: { key: string }, error: string, now: number) {
  syncIncident(target, "down", error, now - MINUTE);
  syncIncident(target, "down", error, now);
}

export const addTarget = (input: Partial<NewTarget> & { key: string }, now = NOW) =>
  createTarget({ title: input.key, kind: "http", ...input }, now);

/** Serves `handler` on a free local port; `close` stops it. */
export async function serve(app: express.Express | Parameters<typeof createServer>[1]) {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
