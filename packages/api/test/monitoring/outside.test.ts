import { createHmac } from "crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const hook = vi.hoisted(() => ({ onOutsideStatusChange: vi.fn() }));
vi.mock("../../src/monitoring/outside-hook.js", () => hook);

import { db } from "../../src/db/index.js";
import { monitorChecks, monitorWarnings, settings } from "../../src/db/schema.js";
import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import { ingestReport, lastOutsidePorts, outsideRow, replayStatus, type OutsideReport } from "../../src/monitoring/outside.js";
import { syncWarnings } from "../../src/monitoring/merge.js";
import monitoringRoutes, { monitoringOutsideRoutes } from "../../src/routes/monitoring.js";
import { addTarget, clearMonitoring, MINUTE, NOW, serve } from "./helpers.js";

const SECRET = "outside-test-secret";
let api: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  // The same order as index.ts: the outside route reads bytes, then the JSON parser serves everything else.
  const app = express();
  app.use("/api/monitoring/outside", monitoringOutsideRoutes);
  app.use(express.json());
  app.use("/api/monitoring", monitoringRoutes);
  api = await serve(app);
});
afterAll(() => api.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearMonitoring();
  db.delete(settings).run();
  saveSecret("MONITOR_OUTSIDE_SECRET", SECRET);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  deleteSecret("MONITOR_OUTSIDE_SECRET");
});

const sign = (timestamp: string, body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
const seconds = (ms = NOW) => String(Math.floor(ms / 1000));

interface Send { timestamp?: string; signature?: string | null; contentType?: string }
/** Posts as the Worker does. Pass `signature: null` to leave the header out. */
function post(report: object | string, send: Send = {}) {
  const body = typeof report === "string" ? report : JSON.stringify(report);
  const timestamp = send.timestamp ?? seconds();
  return fetch(`${api.url}/api/monitoring/outside`, {
    method: "POST",
    headers: {
      "content-type": send.contentType ?? "application/json",
      "x-chomp-timestamp": timestamp,
      ...(send.signature !== null && { "x-chomp-signature": send.signature ?? sign(timestamp, body) }),
    },
    body,
  });
}

const report = (results: OutsideReport["results"], extra: Partial<OutsideReport> = {}): OutsideReport =>
  ({ ts: NOW, vantage: "outside", results, ...extra });
const pass = (key: string, latencyMs = 80) => ({ key, ok: true, statusCode: 200, latencyMs, error: null });
const fail = (key: string, error = "timeout") => ({ key, ok: false, statusCode: null, latencyMs: 8001, error });
const outsideChecks = () => db.select().from(monitorChecks).all().filter((c) => c.vantage === "outside");

const publicTarget = (key = "grafana") => addTarget({ key, url: `https://${key}.example.com/`, exposure: "public-tunnel" });

describe("signature", () => {
  test("a good signature stores each result as an outside check with the report's own time", async () => {
    publicTarget();
    const ts = NOW - 20_000;
    const res = await post(report([pass("grafana", 84)], { ts }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1, duplicate: 0, unknownKeys: 0, changes: 1 });
    expect(outsideChecks()).toMatchObject([{ targetKey: "grafana", vantage: "outside", ok: true, statusCode: 200, latencyMs: 84, error: null, ts }]);
  });

  test("a wrong signature, a wrong secret, a missing header and a re-dated timestamp are all 401 and store nothing", async () => {
    publicTarget();
    const body = JSON.stringify(report([pass("grafana")]));
    expect((await post(body, { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect((await post(body, { signature: sign(seconds(), body, "another-secret") })).status).toBe(401);
    expect((await post(body, { signature: "sha256=abc" })).status).toBe(401);
    expect((await post(body, { signature: null })).status).toBe(401);
    // The timestamp is part of what is signed.
    expect((await post(body, { timestamp: seconds(NOW + 1000), signature: sign(seconds(), body) })).status).toBe(401);
    expect(outsideChecks()).toEqual([]);
  });

  test("a correctly signed timestamp outside the 300 s window is 401, old or from the future", async () => {
    publicTarget();
    const body = JSON.stringify(report([pass("grafana")]));
    for (const skew of [-301_000, 301_000]) {
      const timestamp = seconds(NOW + skew);
      expect((await post(body, { timestamp, signature: sign(timestamp, body) })).status).toBe(401);
    }
    const edge = seconds(NOW - 299_000);
    expect((await post(body, { timestamp: edge, signature: sign(edge, body) })).status).toBe(200);
    expect(outsideChecks()).toHaveLength(1);
  });

  test("a replayed body inside the window adds nothing, and outside the window is refused", async () => {
    publicTarget();
    const body = JSON.stringify(report([pass("grafana")]));
    expect((await post(body)).status).toBe(200);
    const again = await post(body);
    expect(await again.json()).toMatchObject({ ok: true, stored: 0, duplicate: 1 });
    expect(outsideChecks()).toHaveLength(1);

    vi.setSystemTime(NOW + 6 * MINUTE);
    expect((await post(body, { timestamp: seconds(NOW) })).status).toBe(401);
    expect(outsideChecks()).toHaveLength(1);
  });

  test("the signature covers the raw bytes: odd spacing and unicode verify, one changed byte does not", async () => {
    publicTarget();
    const messy = `{ "vantage":"outside",\n  "results":[ {"key":"grafana","ok":false,"statusCode":null,"latencyMs":5,"error":"fetch failed: ø ✓"} ],\n\t"ts" : ${NOW} }`;
    expect((await post(messy, { contentType: "text/plain" })).status).toBe(200);
    expect(outsideChecks()[0].error).toBe("fetch failed: ø ✓");

    const tampered = messy.replace('"latencyMs":5', '"latencyMs":6');
    expect((await post(tampered, { signature: sign(seconds(), messy) })).status).toBe(401);
  });

  test("without the secret set, Chomp cannot verify and says so", async () => {
    deleteSecret("MONITOR_OUTSIDE_SECRET");
    expect((await post(report([]))).status).toBe(503);
  });

  test("a signed body that is not JSON, or breaks the contract, is 400", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ ts: NOW, vantage: "home", results: [] })).status).toBe(400);
    expect((await post({ ts: NOW, vantage: "outside", results: [{ key: "x" }] })).status).toBe(400);
    expect((await post({ ts: NOW, vantage: "outside", results: [], ports: [{ port: 70000, open: true }] })).status).toBe(400);
    expect((await post(report([], { ts: NOW - 3_600_000 }))).status).toBe(400);
  });

  test("an empty report, the Worker's heartbeat, is accepted", async () => {
    const res = await post(report([]));
    expect(await res.json()).toEqual({ ok: true, stored: 0, duplicate: 0, unknownKeys: 0, changes: 0 });
  });
});

describe("partial reports", () => {
  test("a URL missing from a report is not down, and keys Chomp does not know or has retired are ignored", async () => {
    publicTarget("a");
    publicTarget("b");
    await post(report([pass("a")], { ts: NOW - 2 * MINUTE }));
    await post(report([pass("b")], { ts: NOW - 2 * MINUTE }));
    const res = await post(report([fail("a", "HTTP 502"), pass("ghost")]));
    expect(await res.json()).toMatchObject({ stored: 1, unknownKeys: 1 });
    expect(outsideChecks().filter((c) => c.targetKey === "b")).toHaveLength(1);
    expect(outsideRow("b", NOW)).toMatchObject({ state: "up" });
    expect(outsideRow("a", NOW)).toMatchObject({ state: "up", error: "HTTP 502" });

    addTarget({ key: "old", exposure: "public-tunnel", retiredAt: new Date(NOW).toISOString() });
    expect(await (await post(report([pass("old")]))).json()).toMatchObject({ stored: 0, unknownKeys: 1 });
  });
});

describe("outside status", () => {
  const send = (key: string, results: boolean[], from = 0) =>
    results.forEach((ok, i) => ingestReport(report([ok ? pass(key) : fail(key, `err ${from + i}`)], { ts: NOW + (from + i) * MINUTE }), NOW + (from + i) * MINUTE));

  test("down after 3 failures in a row, up after 2 passes", () => {
    publicTarget();
    send("grafana", [true]);
    expect(outsideRow("grafana", NOW)).toMatchObject({ state: "up" });

    send("grafana", [false, false], 1);
    expect(outsideRow("grafana", NOW + 2 * MINUTE).state).toBe("up");
    send("grafana", [false], 3);
    expect(outsideRow("grafana", NOW + 3 * MINUTE)).toMatchObject({ state: "down", error: "err 3" });

    send("grafana", [true], 4);
    expect(outsideRow("grafana", NOW + 4 * MINUTE)).toMatchObject({ state: "down", error: "err 3" });
    send("grafana", [true], 5);
    expect(outsideRow("grafana", NOW + 5 * MINUTE)).toMatchObject({ state: "up", error: null });
  });

  test("the hook runs once per change, with the status and the error", () => {
    const target = publicTarget();
    send("grafana", [true, false, false, false, true, true]);
    expect(hook.onOutsideStatusChange.mock.calls.map(([t, status, error]) => [t.key, status, error])).toEqual([
      [target.key, "up", null],
      [target.key, "down", "err 3"],
      [target.key, "up", null],
    ]);
    expect(hook.onOutsideStatusChange.mock.calls[1][3]).toBe(NOW + 3 * MINUTE);
  });

  test("a failing hook does not fail the report", () => {
    publicTarget();
    hook.onOutsideStatusChange.mockImplementationOnce(() => { throw new Error("boom"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(ingestReport(report([pass("grafana")]), NOW)).toMatchObject({ stored: 1, changes: 1 });
    error.mockRestore();
  });

  test("outside checks do not touch the home status", () => {
    publicTarget();
    send("grafana", [false, false, false]);
    expect(db.select().from(monitorChecks).all().every((c) => c.vantage === "outside")).toBe(true);
    expect(addTarget({ key: "other" }).status).toBe("unknown");
  });

  test("results that arrive out of order are judged by their own time", () => {
    publicTarget();
    ingestReport(report([pass("grafana")], { ts: NOW + 3 * MINUTE }), NOW + 3 * MINUTE);
    ingestReport(report([fail("grafana")], { ts: NOW + 2 * MINUTE }), NOW + 3 * MINUTE);
    expect(outsideRow("grafana", NOW + 3 * MINUTE)).toMatchObject({ state: "up", latencyMs: 80 });
  });

  test("no report for 15 minutes makes the state stale, and a target never checked is unknown", () => {
    publicTarget();
    expect(outsideRow("grafana", NOW)).toEqual({ state: "unknown", lastCheckAt: null, latencyMs: null, error: null });
    send("grafana", [true]);
    expect(outsideRow("grafana", NOW + 14 * MINUTE).state).toBe("up");
    expect(outsideRow("grafana", NOW + 16 * MINUTE)).toMatchObject({ state: "stale", lastCheckAt: new Date(NOW).toISOString() });
  });

  test("replayStatus: a first pass is enough, a first failure is not", () => {
    expect(replayStatus([{ ok: true }])).toBe("up");
    expect(replayStatus([{ ok: false }])).toBe("unknown");
    expect(replayStatus([{ ok: false }, { ok: false }, { ok: false }, { ok: true }])).toBe("down");
    expect(replayStatus([])).toBe("unknown");
  });
});

describe("ports", () => {
  const openWarnings = () => db.select().from(monitorWarnings).all().filter((w) => !w.resolvedAt).map((w) => w.key).sort();
  const ports = (open: number[], ts = NOW, all = [22, 80, 443, 5433]) =>
    ingestReport(report([], { ts, ports: all.map((port) => ({ port, open: open.includes(port) })) }), ts);

  test("an open port opens a warning, and closing it resolves the warning", () => {
    ports([5433]);
    expect(openWarnings()).toEqual(["port-open-internet:5433"]);
    expect(db.select().from(monitorWarnings).get()).toMatchObject({ kind: "port-open-internet", targetKey: null, text: expect.stringContaining("5433") });

    ports([5433, 22], NOW + 15 * MINUTE);
    expect(openWarnings()).toEqual(["port-open-internet:22", "port-open-internet:5433"]);

    ports([], NOW + 30 * MINUTE);
    expect(openWarnings()).toEqual([]);
    expect(db.select().from(monitorWarnings).all()).toHaveLength(2);
  });

  test("the latest results are kept, and an older report does not replace them", () => {
    ports([22], NOW + 15 * MINUTE);
    ports([], NOW);
    expect(lastOutsidePorts()).toEqual({ ts: NOW + 15 * MINUTE, ports: [{ port: 22, open: true }, { port: 80, open: false }, { port: 443, open: false }, { port: 5433, open: false }] });
    expect(openWarnings()).toEqual(["port-open-internet:22"]);
  });

  test("a report without ports leaves the port warnings alone, and other warnings are never resolved", () => {
    syncWarnings([{ key: "public-direct:x.example.com", kind: "public-direct", targetKey: "x.example.com", text: "x" }], ["public-direct"], NOW);
    ports([443]);
    ingestReport(report([]), NOW + MINUTE);
    expect(openWarnings()).toEqual(["port-open-internet:443", "public-direct:x.example.com"]);
    ports([], NOW + 2 * MINUTE);
    expect(openWarnings()).toEqual(["public-direct:x.example.com"]);
  });

  test("a port report arrives through the route", async () => {
    const res = await post(report([], { ports: [{ port: 22, open: true }] }));
    expect(res.status).toBe(200);
    expect(openWarnings()).toEqual(["port-open-internet:22"]);
    const view = (await (await fetch(`${api.url}/api/monitoring/ports`)).json()) as { outside: { ports: unknown[] } };
    expect(view.outside.ports).toEqual([{ port: 22, open: true }]);
  });
});

describe("views", () => {
  test("target rows carry the outside state for public targets only", async () => {
    publicTarget();
    addTarget({ key: "lan-only", exposure: "lan" });
    await post(report([pass("grafana", 91)]));
    const { targets } = (await (await fetch(`${api.url}/api/monitoring/targets`)).json()) as { targets: { key: string; outside: unknown }[] };
    expect(targets.find((t) => t.key === "grafana")?.outside).toEqual({ state: "up", lastCheckAt: new Date(NOW).toISOString(), latencyMs: 91, error: null });
    expect(targets.find((t) => t.key === "lan-only")?.outside).toBeNull();
  });

  test("exposure says per public target whether the outside probe confirmed it", async () => {
    publicTarget("seen");
    publicTarget("unseen");
    addTarget({ key: "inside", exposure: "lan" });
    await post(report([pass("seen")]));
    const view = (await (await fetch(`${api.url}/api/monitoring/exposure`)).json()) as { levels: { level: string; targets: { key: string; outside: { state: string } | null }[] }[] };
    const tunnel = view.levels.find((l) => l.level === "public-tunnel")!;
    expect(Object.fromEntries(tunnel.targets.map((t) => [t.key, t.outside?.state]))).toEqual({ seen: "up", unseen: "unknown" });
    expect(view.levels.find((l) => l.level === "lan")!.targets[0].outside).toBeNull();
  });
});
