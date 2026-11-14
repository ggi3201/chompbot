import express from "express";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { hostMetrics, incidents } from "../../src/db/schema.js";
import { deleteSecret, getSecret, saveSecret } from "../../src/lib/secrets.js";
import { checkHost } from "../../src/monitoring/checks.js";
import { runDueChecks } from "../../src/monitoring/engine.js";
import { buildHostTiles } from "../../src/monitoring/host-views.js";
import { acceptReport, hostAddress, senderAddress, tokenSetting } from "../../src/monitoring/hosts.js";
import monitoringRoutes, { monitoringHostReportRoutes } from "../../src/routes/monitoring.js";
import { getTarget } from "../../src/monitoring/store.js";
import { json } from "./fixtures.js";
import { clearMonitoring, MINUTE, serve } from "./helpers.js";

const TOKEN = "rpi-token-0123456789abcdefghij";
const report = json("rpi-report.json");
let api: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  const app = express();
  // As in index.ts: the host router comes before the JSON parser, which would otherwise parse the body first.
  app.use("/api/monitoring/hosts", monitoringHostReportRoutes);
  app.use(express.json({ limit: "40mb" }));
  app.use("/api/monitoring", monitoringRoutes);
  api = await serve(app);
});
afterAll(() => api.close());
beforeEach(() => {
  clearMonitoring();
  saveSecret(tokenSetting("rpi"), TOKEN);
  deleteSecret(tokenSetting("macbook"));
});

const send = (host: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${api.url}/api/monitoring/hosts/${host}/report`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const metricRows = () => db.select().from(hostMetrics).all();

test("a good report is stored as one row per metric and answers 204", async () => {
  const res = await send("rpi", report);
  expect(res.status).toBe(204);
  const rows = metricRows();
  expect(rows).toHaveLength(Object.keys(report.metrics).length);
  expect(rows.every((r) => r.host === "rpi")).toBe(true);
  expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toMatchObject({ cpu_pct: 0, mem_pct: 11.8, disk_pct: 12.9, temp_c: 54, uptime_sec: 9482135 });
  // The receive time is the time of the rows; the agent's clock is not trusted.
  expect(new Set(rows.map((r) => r.ts)).size).toBe(1);
  expect(Math.abs(rows[0].ts - Date.now())).toBeLessThan(5_000);
});

test("the first report makes the host's target, and later ones keep it fresh", async () => {
  expect(getTarget("host:rpi")).toBeUndefined();
  await send("rpi", report);
  const first = getTarget("host:rpi")!;
  expect(first).toMatchObject({ kind: "host", host: "rpi", title: "rpi", tracked: true, project: "Infra", sources: ["agent"], lastPushOk: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await send("rpi", report);
  expect(getTarget("host:rpi")!.lastPushAt).toBeGreaterThan(first.lastPushAt!);
});

test("the MacBook is untracked by default, so a sleeping laptop is no alarm", async () => {
  saveSecret(tokenSetting("macbook"), "mac-token-0123456789abcdefghij");
  await send("macbook", { ...report, host: "macbook", agent: "macos", metrics: { ...report.metrics, battery_pct: 64 } }, "mac-token-0123456789abcdefghij");
  expect(getTarget("host:macbook")).toMatchObject({ tracked: false });
  expect(metricRows().find((r) => r.metric === "battery_pct")?.value).toBe(64);
});

test("a wrong, missing or malformed token, and an unknown host, all get the same 401 and store nothing", async () => {
  deleteSecret(tokenSetting("macbook"));
  const answers = await Promise.all([
    send("rpi", report, "wrong"),
    send("rpi", report, null),
    send("macbook", { ...report, host: "macbook" }),
    send("RPI", { ...report, host: "RPI" }),
    send("mini", { ...report, host: "mini" }),
  ]);
  expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
  expect(new Set(await Promise.all(answers.map((r) => r.text()))).size).toBe(1);
  expect(metricRows()).toHaveLength(0);
  expect(getTarget("host:rpi")).toBeUndefined();
});

test("a body that breaks the contract, or whose host differs from the path, gets 400 with the reason, and stores nothing", async () => {
  const differs = await send("rpi", { ...report, host: "macbook" });
  expect(differs.status).toBe(400);
  expect(await differs.json()).toMatchObject({ error: expect.stringContaining("differs") });
  const { cpu_pct: _cpu, ...withoutCpu } = report.metrics;
  const bad = [
    { ...report, metrics: withoutCpu },
    { ...report, metrics: { ...report.metrics, mem_pct: 140 } },
    { ...report, metrics: { ...report.metrics, disk_pct: "full" } },
    { ...report, metrics: { ...report.metrics, temp_c: null } },
    { ...report, agent: "windows" },
    { ...report, listeners: [{ bind: "0.0.0.0", port: 70_000 }] },
    { ...report, containers: [{ Image: "x", State: "running" }] },
    { host: "rpi" },
  ];
  for (const body of bad) expect((await send("rpi", body)).status).toBe(400);
  expect(await (await send("rpi", { ...report, metrics: withoutCpu })).json()).toMatchObject({ error: expect.stringContaining("metrics.cpu_pct") });
  expect((await send("rpi", "{not json")).status).toBe(400);
  expect(metricRows()).toHaveLength(0);
});

test("a report over 1 MB gets 413, although the app parses 40 MB elsewhere", async () => {
  const big = { ...report, containers: Array.from({ length: 4000 }, (_, i) => ({ ...report.containers[0], ID: String(i), Labels: "x".repeat(300) })) };
  expect(JSON.stringify(big).length).toBeGreaterThan(1_048_576);
  expect((await send("rpi", big)).status).toBe(413);
  expect(metricRows()).toHaveLength(0);
  // A report the size of a busy host's (64 KB, dozens of containers) is accepted.
  const busy = { ...report, containers: Array.from({ length: 40 }, (_, i) => ({ ...report.containers[0], Names: `c${i}`, Labels: "k=v,".repeat(100) })) };
  expect(JSON.stringify(busy).length).toBeGreaterThan(20_000);
  expect((await send("rpi", busy)).status).toBe(204);
});

test("the sender's address is remembered when the mini can use it, and not when a proxy hides it", async () => {
  expect(senderAddress("::ffff:100.64.0.9")).toBe("100.64.0.9");
  expect(senderAddress("10.0.2.148")).toBe("10.0.2.148");
  expect(senderAddress("::ffff:127.0.0.1")).toBeNull();
  expect(senderAddress("::1")).toBeNull();
  expect(senderAddress(undefined)).toBeNull();
  await send("rpi", report); // from this machine, so loopback
  expect(hostAddress("rpi")).toBeNull();
});

// ── Tokens ──────────────────────────────────────────────────────────────

const issue = (host: string) => fetch(`${api.url}/api/monitoring/hosts/${host}/token`, { method: "POST" });

test("the token route makes a token, stores it encrypted under the host's setting, and the host can then report", async () => {
  const res = await issue("macbook");
  expect(res.status).toBe(200);
  const { host, setting, token } = await res.json();
  expect(host).toBe("macbook");
  expect(setting).toBe("MONITOR_HOST_TOKEN_MACBOOK");
  expect(token).toMatch(/^[\w-]{32}$/);
  expect(getSecret("MONITOR_HOST_TOKEN_MACBOOK")).toBe(token);
  const stored = db.$client.prepare("SELECT value FROM settings WHERE key = ?").get("secret:MONITOR_HOST_TOKEN_MACBOOK") as { value: string };
  expect(stored.value).not.toContain(token);
  expect((await send("macbook", { ...report, host: "macbook", agent: "macos" }, token)).status).toBe(204);
});

test("a new token replaces the old one", async () => {
  const { token } = await (await issue("rpi")).json();
  expect(token).not.toBe(TOKEN);
  expect((await send("rpi", report, TOKEN)).status).toBe(401);
  expect((await send("rpi", report, token)).status).toBe(204);
});

test("hosts that need no agent, and bad names, get no token", async () => {
  for (const host of ["mini", "ha", "Bad_Name", "-x"]) expect((await issue(host)).status).toBe(400);
  expect(getSecret("MONITOR_HOST_TOKEN_MINI")).toBeNull();
  // A dashed host name maps to an underscored setting.
  expect(tokenSetting("living-room-pi")).toBe("MONITOR_HOST_TOKEN_LIVING_ROOM_PI");
});

// ── Host state ──────────────────────────────────────────────────────────

const stateOf = (host: string, now: number) => buildHostTiles(now).hosts.find((h) => h.host === host)!;

test("a host is up for 3 minutes after its report, then down; a known host that never reported has no tile", async () => {
  await send("rpi", report);
  const seen = getTarget("host:rpi")!.lastPushAt!;
  expect(stateOf("rpi", seen + 2 * MINUTE).state).toBe("up");
  expect(stateOf("rpi", seen + 3 * MINUTE).state).toBe("up");
  expect(stateOf("rpi", seen + 3 * MINUTE + 1).state).toBe("down");
  expect(stateOf("macbook", seen)).toBeUndefined();
  expect(stateOf("mini", seen)).toMatchObject({ state: "unknown", agent: null });
  expect(stateOf("rpi", seen).lastSeen).toBe(new Date(seen).toISOString());
});

test("tiles list this machine and the known hosts that reported, in order, with the latest readings and what the host has", async () => {
  await send("rpi", report);
  const { hosts, limits } = buildHostTiles(Date.now());
  expect(hosts.map((h) => h.host)).toEqual(["mini", "rpi"]);
  expect(limits).toEqual({ mem: 90, disk: 85 });
  expect(hosts[1]).toMatchObject({
    title: "rpi", agent: "linux", state: "up", uptimeSec: 9482135,
    metrics: { cpu: 0, mem: 11.8, disk: 12.9, temp: 54 },
  });
  expect(hosts[1].metrics).not.toHaveProperty("battery");
  expect(hosts[0].metrics).toEqual({ cpu: null, mem: null, disk: null });
  // A host with another name that reports gets its own tile.
  saveSecret(tokenSetting("garage-pi"), "garage-0123456789abcdefghijkl");
  await send("garage-pi", { ...report, host: "garage-pi" }, "garage-0123456789abcdefghijkl");
  expect(buildHostTiles(Date.now()).hosts.map((h) => h.host)).toEqual(["mini", "rpi", "garage-pi"]);
  deleteSecret(tokenSetting("garage-pi"));
});

test("GET /hosts and the metrics route answer through the router", async () => {
  await send("rpi", report);
  const tiles = await (await fetch(`${api.url}/api/monitoring/hosts`)).json();
  expect(tiles.hosts.find((h: { host: string }) => h.host === "rpi")).toMatchObject({ state: "up" });
  expect((await fetch(`${api.url}/api/monitoring/hosts/rpi/metrics?range=1y`)).status).toBe(400);
  expect((await fetch(`${api.url}/api/monitoring/hosts/R_PI/metrics`)).status).toBe(400);
  const series = await (await fetch(`${api.url}/api/monitoring/hosts/rpi/metrics`)).json();
  expect(series).toMatchObject({ host: "rpi", range: "24h", series: { cpu: [0], mem: [11.8], disk: [12.9], load1: [0] } });
  expect(series.times).toHaveLength(1);
});

// ── The check ───────────────────────────────────────────────────────────

test("checkHost passes inside the 3-minute window and fails outside it or before any report", () => {
  const now = 10 * MINUTE;
  expect(checkHost({ lastPushAt: now - 3 * MINUTE }, now)).toMatchObject({ ok: true });
  expect(checkHost({ lastPushAt: now - 3 * MINUTE - 1 }, now)).toMatchObject({ ok: false, error: "No report in 3 minutes" });
  expect(checkHost({ lastPushAt: null }, now)).toMatchObject({ ok: false, error: "Never reported" });
});

test("a tracked host that goes silent is down after one check and opens an incident; the untracked MacBook does not", async () => {
  saveSecret(tokenSetting("macbook"), "mac-token-0123456789abcdefghij");
  await send("rpi", report);
  await send("macbook", { ...report, host: "macbook", agent: "macos" }, "mac-token-0123456789abcdefghij");
  const later = Date.now() + 10 * MINUTE;
  await runDueChecks(later);
  expect(getTarget("host:rpi")).toMatchObject({ status: "down" });
  expect(getTarget("host:macbook")).toMatchObject({ status: "down" });
  await runDueChecks(later + MINUTE); // the engine holds a new incident for one check cycle
  expect(db.select().from(incidents).all().map((i) => i.causeKey)).toEqual(["host:rpi"]);
  // Reports come back: up at the next check.
  acceptReport("rpi", report, null, later + MINUTE + 30_000);
  await runDueChecks(later + 2 * MINUTE + 1_000);
  expect(getTarget("host:rpi")).toMatchObject({ status: "up" });
  expect(db.select().from(incidents).get()).toMatchObject({ state: "resolved" });
});
