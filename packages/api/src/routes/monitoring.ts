import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ActionError, readLogs, restartTarget } from "../monitoring/actions.js";
import { applyPush } from "../monitoring/engine.js";
import { buildHostSeries, buildHostTiles, HOST_RANGES } from "../monitoring/host-views.js";
import { acceptReport, HOST_NAME, hostDef, hostTokenMatches, issueHostToken, senderAddress, tokenSetting } from "../monitoring/hosts.js";
import { startDiagnosis } from "../monitoring/diagnose.js";
import { closeIncidentOf, getIncident, listIncidents } from "../monitoring/incidents.js";
import { buildExposure, buildPorts } from "../monitoring/inventory.js";
import { buildLatency, LATENCY_RANGES } from "../monitoring/latency.js";
import { lastDiscovery } from "../monitoring/run.js";
import { getSecret } from "../lib/secrets.js";
import { ingestReport, lastOutsidePorts, parseReport, verifySignature } from "../monitoring/outside.js";
import { findPushTarget, getTarget, patchTarget } from "../monitoring/store.js";
import { buildOverview, buildTargetRows, openWarnings } from "../monitoring/views.js";

const router: ReturnType<typeof Router> = Router();

/** GET /api/monitoring/overview: verdict counts and what needs attention. */
router.get("/overview", (_req, res) => {
  res.json(buildOverview(buildTargetRows()));
});

/** GET /api/monitoring/targets: one row per target with state, latency and 30 days of history. */
router.get("/targets", (_req, res) => {
  const targets = buildTargetRows();
  res.json({ checkedAt: buildOverview(targets).checkedAt, targets });
});

const patchSchema = z.object({
  tracked: z.boolean(),
  hidden: z.boolean(),
  title: z.string().trim().min(1).max(120),
  project: z.string().trim().max(60).transform((v) => v || null).nullable(),
  notes: z.string().trim().max(2000).transform((v) => v || null).nullable(),
  expectedStatus: z.number().int().min(100).max(599).nullable(),
}).partial().strict().refine((patch) => Object.keys(patch).length > 0, "Nothing to change");

/** PATCH /api/monitoring/targets/:key: edits the fields a person owns. Discovery no longer touches the ones sent. */
router.patch("/targets/:key", (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ") });
    return;
  }
  const key = String(req.params.key);
  if (!patchTarget(key, parsed.data)) {
    res.status(404).json({ error: "Target not found" });
    return;
  }
  if (parsed.data.tracked === false) closeIncidentOf(key, Date.now(), "is no longer tracked");
  res.json({ target: buildTargetRows().find((row) => row.key === key) });
});

/** GET /api/monitoring/targets/:key/logs: the last 100 lines of the container or unit behind a target on the mini. */
router.get("/targets/:key/logs", async (req, res) => {
  try {
    res.json(await readLogs(String(req.params.key)));
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

/** POST /api/monitoring/targets/:key/restart: restarts a container, or a systemd unit listed in MONITOR_RESTART_UNITS. */
router.post("/targets/:key/restart", async (req, res) => {
  try {
    res.json({ ok: true, message: await restartTarget(String(req.params.key)) });
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    res.status(err.status).json({ ok: false, message: err.message });
  }
});

const latencyQuery = z.object({ range: z.enum(LATENCY_RANGES).default("24h") });

/** GET /api/monitoring/targets/:key/latency?range=24h|7d: latency per vantage in fixed buckets. */
router.get("/targets/:key/latency", (req, res) => {
  const parsed = latencyQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: `range must be one of ${LATENCY_RANGES.join(", ")}` });
    return;
  }
  const key = String(req.params.key);
  if (!getTarget(key)) {
    res.status(404).json({ error: "Target not found" });
    return;
  }
  res.json(buildLatency(key, parsed.data.range));
});

/** GET /api/monitoring/ports: every listening port of the last discovery run, with its owner and the target that checks it. */
router.get("/ports", (_req, res) => {
  const run = lastDiscovery();
  res.json({ discoveredAt: run?.at ?? null, ports: buildPorts(run, buildTargetRows()), outside: lastOutsidePorts() });
});

/** GET /api/monitoring/exposure: visible targets grouped by how far they reach, widest first, with the warnings of each level. */
router.get("/exposure", (_req, res) => {
  res.json(buildExposure(buildTargetRows(), openWarnings()));
});

/** GET /api/monitoring/discovery: when discovery last ran and how each source answered. */
router.get("/discovery", (_req, res) => {
  const run = lastDiscovery();
  res.json({ lastRunAt: run?.at ?? null, durationMs: run?.durationMs ?? null, sources: run?.sources ?? [], summary: run?.summary ?? null });
});

/** GET /api/monitoring/incidents: open incidents and the resolved ones of the last 30 days. */
router.get("/incidents", (_req, res) => {
  res.json({ incidents: listIncidents() });
});

/** POST /api/monitoring/refresh: discovery, host stats and every check now, instead of on their timers. */
router.post("/refresh", async (_req, res) => {
  const { refreshNow } = await import("../monitoring/start.js");
  res.json(await refreshNow());
});

/** GET /api/monitoring/hosts: one tile per host, with the latest readings and a day of trend. */
router.get("/hosts", (_req, res) => {
  res.json(buildHostTiles());
});

const rangeSchema = z.enum(HOST_RANGES);

/** GET /api/monitoring/hosts/:host/metrics?range=24h|7d|30d: cpu, memory, disk and load for a chart. */
router.get("/hosts/:host/metrics", (req, res) => {
  const host = String(req.params.host);
  const range = rangeSchema.safeParse(req.query.range ?? "24h");
  if (!HOST_NAME.test(host) || !range.success) {
    res.status(400).json({ error: `Use a host name and a range of ${HOST_RANGES.join(", ")}` });
    return;
  }
  res.json(buildHostSeries(host, range.data));
});

/** POST /api/monitoring/hosts/:host/token: makes the agent token for a host, replacing the old one, and returns it this once. */
router.post("/hosts/:host/token", (req, res) => {
  const host = String(req.params.host);
  if (!HOST_NAME.test(host)) {
    res.status(400).json({ error: "Use a name of lowercase letters, digits and dashes" });
    return;
  }
  if (hostDef(host).agent === null) {
    res.status(400).json({ error: "This host has no agent" });
    return;
  }
  res.json({ host, setting: tokenSetting(host), token: issueHostToken(host) });
});

/** GET /api/monitoring/incidents/:id: the incident with its services, timeline and diagnosis. */
router.get("/incidents/:id", (req, res) => {
  const incident = getIncident(String(req.params.id));
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }
  res.json({ incident });
});

/** POST /api/monitoring/incidents/:id/diagnose: starts a read-only agent diagnosis and returns at once. The answer lands on the incident. */
router.post("/incidents/:id/diagnose", (req, res) => {
  const start = startDiagnosis(String(req.params.id));
  if (start.started) {
    res.status(202).json({ status: "running" });
    return;
  }
  res.status(start.reason === "running" ? 409 : 404).json({ error: start.reason === "running" ? "A diagnosis is already running" : "Incident not found" });
});

export default router;

// ── Push jobs ───────────────────────────────────────────────────────────
// Public: the token in the URL is the credential, as in Kuma. Mounted before the JWT middleware.

const TOKEN = /^[\w-]{16,64}$/;
const pushSchema = z.object({
  status: z.enum(["up", "down"]).default("up"),
  msg: z.string().transform((msg) => msg.slice(0, 500)).optional(),
  ping: z.coerce.number().min(0).max(86_400_000).optional(),
});

/** Kuma's push contract: GET or POST /push/:token?status=up|down&msg=...&ping=<ms>. Query wins over a JSON body. */
function receivePush(req: Request, res: Response) {
  const token = String(req.params.token);
  const target = TOKEN.test(token) ? findPushTarget(token) : undefined;
  if (!target) {
    res.status(404).json({ ok: false, msg: "Push monitor not found" });
    return;
  }
  // Kuma's URL templates send empty values (`ping=`); an empty value is a missing one.
  const given = Object.entries({ ...(req.body as object | undefined), ...req.query }).filter(([, value]) => value !== "");
  const parsed = pushSchema.safeParse(Object.fromEntries(given));
  if (!parsed.success) {
    res.status(400).json({ ok: false, msg: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
    return;
  }
  const { status, msg, ping } = parsed.data;
  applyPush(target, { ok: status === "up", msg: msg ?? null, latencyMs: ping === undefined ? null : Math.round(ping) }, Date.now());
  res.json({ ok: true });
}

export const monitoringPushRoutes: ReturnType<typeof Router> = Router();
monitoringPushRoutes.get("/:token", receivePush);
monitoringPushRoutes.post("/:token", receivePush);

// ── Host reports ────────────────────────────────────────────────────────
// Public: each host has its own bearer token (scripts/host-agent/CONTRACT.md). Mounted before the global JSON parser, whose
// limit is far above what a report needs, so that this route's own 1 MB limit is the one that applies.

const percent = z.number().min(0).max(100);
const amount = z.number().min(0);
const reportSchema = z.object({
  host: z.string(),
  ts: z.number().int().nonnegative(),
  agent: z.enum(["linux", "macos"]),
  metrics: z.object({
    cpu_pct: percent, mem_pct: percent, mem_used_gb: amount, mem_total_gb: amount,
    disk_pct: percent, disk_used_gb: amount, disk_total_gb: amount,
    load1: amount, load5: amount, uptime_sec: z.number().int().nonnegative(),
    temp_c: z.number().min(-50).max(200).optional(),
    battery_pct: percent.optional(),
  }),
  listeners: z.array(z.object({ bind: z.string().min(1).max(64), port: z.number().int().min(1).max(65_535), process: z.string().max(64).optional() })).max(5000),
  // docker ps prints more keys than these; the rest are dropped.
  containers: z.array(z.object({
    Names: z.string().min(1), Image: z.string(), State: z.string(),
    Status: z.string().optional(), Ports: z.string().optional(), Labels: z.string().optional(),
  })).max(1000),
});

function receiveReport(req: Request, res: Response) {
  const host = String(req.params.host);
  const bearer = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
  // An unknown host and a wrong token look the same. The mini and Home Assistant are read here, not reported.
  if (!HOST_NAME.test(host) || hostDef(host).agent === null || !bearer || !hostTokenMatches(host, bearer)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ") });
    return;
  }
  if (parsed.data.host !== host) {
    res.status(400).json({ error: "host in the body differs from the host in the path" });
    return;
  }
  const { metrics, listeners, containers } = parsed.data;
  acceptReport(host, { metrics, listeners, containers }, senderAddress(req.socket.remoteAddress), Date.now());
  res.status(204).end();
}

export const monitoringHostReportRoutes: ReturnType<typeof Router> = Router();
monitoringHostReportRoutes.post("/:host/report", express.json({ limit: "1mb" }), receiveReport);

// ── Outside probe ───────────────────────────────────────────────────────
// Public: the Worker signs each report with MONITOR_OUTSIDE_SECRET (HMAC-SHA256 over "<timestamp>.<raw body>").
// See packages/outside-probe/CONTRACT.md.

const REJECTIONS = { missing: "Missing signature headers", stale: "Timestamp outside the replay window", mismatch: "Bad signature" } as const;

function receiveOutside(req: Request, res: Response) {
  const secret = getSecret("MONITOR_OUTSIDE_SECRET");
  if (!secret) {
    res.status(503).json({ error: "MONITOR_OUTSIDE_SECRET is not set" });
    return;
  }
  // The signature covers the exact bytes. If a JSON parser ran first, the body is no longer the raw one.
  if (!Buffer.isBuffer(req.body)) {
    res.status(500).json({ error: "Raw body not available" });
    return;
  }
  const now = Date.now();
  const verdict = verifySignature({
    secret, body: req.body,
    timestamp: req.header("x-chomp-timestamp"),
    signature: req.header("x-chomp-signature"),
  }, now);
  if (verdict !== "ok") {
    res.status(401).json({ error: REJECTIONS[verdict] });
    return;
  }
  const parsed = parseReport(req.body, now);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  res.json({ ok: true, ...ingestReport(parsed.report, now) });
}

/** Mounted before the global JSON parser in index.ts, so the body reaches the handler as bytes. */
export const monitoringOutsideRoutes: ReturnType<typeof Router> = Router();
monitoringOutsideRoutes.post("/", express.raw({ type: () => true, limit: "512kb" }), receiveOutside);
