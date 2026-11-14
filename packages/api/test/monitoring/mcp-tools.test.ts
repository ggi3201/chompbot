import { beforeEach, expect, test, vi } from "vitest";

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({ ...(await importOriginal<object>()), execFile: child.execFile }));

import { execMonitoringIncidents, execMonitoringStatus, execMonitoringTarget } from "../../src/agents/tools/monitoring.js";
import { db } from "../../src/db/index.js";
import { monitorChecks, monitorWarnings } from "../../src/db/schema.js";
import { MCP_TOOLS } from "../../src/mcp/tool-definitions.js";
import { getMcpTool } from "../../src/mcp/registry.js";
import { syncIncident } from "../../src/monitoring/incidents.js";
import { HOUR, MINUTE, NOW, addTarget, clearMonitoring, downForACycle } from "./helpers.js";

beforeEach(() => {
  clearMonitoring();
  child.execFile.mockReset();
});

const parse = (text: string) => JSON.parse(text);
const checked = NOW - MINUTE;

/** A down web app with an open incident, a healthy API, a quiet one, and a down service nobody tracks. */
function seed() {
  addTarget({ key: "mini:8080", title: "Shop", host: "mini", container: "shop-1", project: "atelier", status: "down", statusSince: "2026-11-08T11:50:00.000Z", lastCheckedAt: checked, url: "http://127.0.0.1:8080" });
  addTarget({ key: "mini:3000", title: "API", host: "mini", project: "chomp", status: "up", lastCheckedAt: checked });
  addTarget({ key: "rpi:53", title: "Pi-hole DNS", host: "rpi", status: "up", lastCheckedAt: NOW - HOUR });
  addTarget({ key: "mini:9000", title: "Scratch", host: "mini", tracked: false, status: "down", lastCheckedAt: checked });
  db.insert(monitorChecks).values([
    { targetKey: "mini:8080", ts: NOW - 2 * MINUTE, ok: false, error: "connection refused" },
    { targetKey: "mini:8080", ts: NOW - MINUTE, ok: false, error: "connection refused" },
  ]).run();
  downForACycle({ key: "mini:8080", title: "Shop", tracked: true }, "connection refused", NOW - 10 * MINUTE);
  db.insert(monitorWarnings).values({ key: "w1", kind: "open-port", targetKey: "mini:8080", text: "Port 8080 is open on the LAN", firstSeen: "2026-11-08T10:00:00.000Z", lastSeen: "2026-11-08T11:00:00.000Z" }).run();
}

test("status says what is down, quiet, and open, and leaves out what nobody tracks", () => {
  seed();
  const status = parse(execMonitoringStatus({}, NOW));
  expect(status.verdict).toBe("1 down, 1 without a recent check");
  expect(status.down).toEqual([expect.objectContaining({ key: "mini:8080", title: "Shop", message: "connection refused" })]);
  expect(status.stale.map((row: { key: string }) => row.key)).toEqual(["rpi:53"]);
  expect(status.openIncidents).toEqual([expect.objectContaining({ title: "Shop is down", targets: ["mini:8080"] })]);
  expect(status.warnings).toEqual([{ key: "w1", kind: "open-port", targetKey: "mini:8080", text: "Port 8080 is open on the LAN", firstSeen: "2026-11-08T10:00:00.000Z", critical: false }]);
  expect(status.counts).toMatchObject({ total: 3, up: 1, down: 1, stale: 1 });
});

test("status with a query looks at matching services only, by name, host or project", () => {
  seed();
  expect(parse(execMonitoringStatus({ query: "pi-hole" }, NOW))).toMatchObject({ verdict: "1 without a recent check", openIncidents: [], warnings: [], down: [] });
  expect(parse(execMonitoringStatus({ query: "chomp" }, NOW))).toMatchObject({ verdict: "all up", openIncidents: [] });
  expect(parse(execMonitoringStatus({ query: "atelier" }, NOW))).toMatchObject({ verdict: "1 down", warnings: [{ key: "w1" }] });
  expect(parse(execMonitoringStatus({ query: "rpi" }, NOW)).counts.total).toBe(1);
});

test("a target is found by key or by part of its name, with its checks and open incident", async () => {
  seed();
  const byKey = parse(await execMonitoringTarget({ target: "mini:8080" }, NOW));
  expect(byKey).toMatchObject({ key: "mini:8080", state: "down", container: "shop-1", project: "atelier", message: "connection refused" });
  expect(byKey.recentChecks.map((c: { error: string }) => c.error)).toEqual(["connection refused", "connection refused"]);
  expect(byKey.openIncident).toMatchObject({ title: "Shop is down", events: [expect.objectContaining({ kind: "opened" })] });
  expect(byKey).not.toHaveProperty("logs");
  expect(byKey).not.toHaveProperty("days");

  const byName = parse(await execMonitoringTarget({ target: "pi-hole" }, NOW));
  expect(byName).toMatchObject({ key: "rpi:53", openIncident: null, recentChecks: [] });
});

test("a name that matches several services lists their keys, and one that matches none says so", async () => {
  addTarget({ key: "mini:1", title: "Redis cache", host: "mini" });
  addTarget({ key: "mini:2", title: "Redis queue", host: "mini" });
  expect(await execMonitoringTarget({ target: "redis" }, NOW)).toBe("ERROR: 2 services match \"redis\". Ask again with one key: mini:1, mini:2");
  expect(await execMonitoringTarget({ target: "nothing" }, NOW)).toMatch(/^ERROR: No monitored service matches "nothing"/);
  expect(await execMonitoringTarget({}, NOW)).toMatch(/^ERROR: target required/);
});

test("logs: true adds the log tail of a service on the mini, and on another host returns the reason inside the result, not a failure", async () => {
  seed();
  child.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, out: string, err2: string) => void) =>
    callback(null, "2026-11-08T11:59:00.000000000Z listening\n", ""));
  const result = parse(await execMonitoringTarget({ target: "mini:8080", logs: true }, NOW));
  expect(result.logs).toEqual({ source: "docker", name: "shop-1", lines: ["2026-11-08T11:59:00.000000000Z listening"] });
  child.execFile.mockClear();
  const remote = parse(await execMonitoringTarget({ target: "rpi:53", logs: true }, NOW));
  expect(remote.logs.error).toMatch(/only work for services on the machine Chomp runs on/);
  expect(child.execFile).not.toHaveBeenCalled();
});

test("incidents list open and recent ones, and open_only drops the resolved", () => {
  seed();
  downForACycle({ key: "mini:3000", title: "API", tracked: true }, "timeout", NOW - 3 * HOUR);
  syncIncident({ key: "mini:3000", title: "API", tracked: true }, "up", null, NOW - 2 * HOUR);
  const all = parse(execMonitoringIncidents({}, NOW)).incidents;
  expect(all.map((i: { title: string; state: string }) => [i.title, i.state])).toEqual([["Shop is down", "open"], ["API is down", "resolved"]]);
  expect(all[0]).toMatchObject({ msg: "connection refused", targets: [{ key: "mini:8080", title: "Shop" }] });
  expect(parse(execMonitoringIncidents({ open_only: true }, NOW)).incidents.map((i: { title: string }) => i.title)).toEqual(["Shop is down"]);
  expect(parse(execMonitoringIncidents({ limit: 1 }, NOW)).incidents).toHaveLength(1);
});

test("through the registry the tools return text and errors are flagged, and no monitoring tool can restart anything", async () => {
  seed();
  expect(MCP_TOOLS.some((tool) => /restart/.test(tool.name) && tool.name.startsWith("monitoring"))).toBe(false);
  expect(getMcpTool("monitoring_incidents")?.handler).toBeTypeOf("function");
  const status = await getMcpTool("monitoring_status")!.handler({}, undefined);
  expect(status.isError).toBeUndefined();
  expect(status.content[0]).toMatchObject({ type: "text" });
  const missing = await getMcpTool("monitoring_target")!.handler({ target: "zzz" }, undefined);
  expect(missing.isError).toBe(true);
});
