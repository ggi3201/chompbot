import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile: child.execFile }));

import { db } from "../../src/db/index.js";
import { monitorTargets, monitorWarnings } from "../../src/db/schema.js";
import { checkReportedContainer } from "../../src/monitoring/checks.js";
import { planTargets, type Found, type Snapshot } from "../../src/monitoring/discover.js";
import { acceptReport, type ReportInput } from "../../src/monitoring/hosts.js";
import { buildPorts } from "../../src/monitoring/inventory.js";
import { MISSED_RUNS_TO_RETIRE } from "../../src/monitoring/merge.js";
import { lastDiscovery, runDiscovery } from "../../src/monitoring/run.js";
import { dedupeListeners, listenerFromReport, parseDockerPs } from "../../src/monitoring/sources.js";
import { getTarget } from "../../src/monitoring/store.js";
import { buildTargetRows } from "../../src/monitoring/views.js";
import { json } from "./fixtures.js";
import { clearMonitoring, MINUTE, NOW } from "./helpers.js";
import { givenMini } from "./mini-mocks.js";

const report: ReportInput & { host: string } = json("rpi-report.json");
const ADDRESS = "100.64.0.9";
const byKey = (found: Found[], key: string) => found.find((f) => f.key === key)!;

/** What the planning reads for a host other than the mini: its listeners and containers, nothing else. */
const piSnapshot = (input: ReportInput = report): Snapshot => ({
  routes: [], tunnel: [], dns: [], homeIp: null, dockerSpace: [], localAddresses: [], statuses: [], tailnetIps: [],
  containers: parseDockerPs(input.containers),
  listeners: dedupeListeners(input.listeners.map(listenerFromReport)),
});
const planPi = () => planTargets(piSnapshot(), new Map(), { name: "rpi", address: ADDRESS });

describe("the Pi's docker ps rows", () => {
  const containers = parseDockerPs(report.containers);

  test("the three containers of a realistic report become containers with their compose project, state and published ports", () => {
    expect(containers.map((c) => c.name)).toEqual(["scraper_app_1", "kali", "portainer_agent"]);
    expect(containers[0]).toMatchObject({
      image: "scraper_app", project: "scraper", state: "running", health: null,
      ports: [{ port: 5000, containerPort: 5000, bind: "0.0.0.0" }],
    });
    expect(containers[1]).toMatchObject({ name: "kali", project: null, ports: [] });
    expect(containers[2]).toMatchObject({ image: "portainer/agent:2.33.7", ports: [{ port: 9001, containerPort: 9001, bind: "0.0.0.0" }] });
  });

  const row = (over: object) => ({ Names: "x", Image: "x", State: "running", ...over });

  test("ports in docker's other forms: IPv6 only, loopback, brackets, ranges, unpublished and udp", () => {
    const ports = (text: string) => parseDockerPs([row({ Ports: text })])[0].ports;
    expect(ports(":::80->80/tcp")).toEqual([{ port: 80, containerPort: 80, bind: "::" }]);
    expect(ports("[::]:80->80/tcp, 0.0.0.0:80->80/tcp")).toEqual([{ port: 80, containerPort: 80, bind: "::" }]);
    expect(ports("127.0.0.1:8080->80/tcp")).toEqual([{ port: 8080, containerPort: 80, bind: "127.0.0.1" }]);
    expect(ports("0.0.0.0:8000-8002->9000-9002/tcp")).toEqual([
      { port: 8000, containerPort: 9000, bind: "0.0.0.0" }, { port: 8001, containerPort: 9001, bind: "0.0.0.0" }, { port: 8002, containerPort: 9002, bind: "0.0.0.0" },
    ]);
    expect(ports("3306/tcp, 53/udp, 0.0.0.0:53->53/udp")).toEqual([]);
    expect(ports("")).toEqual([]);
  });

  test("health comes from the status text", () => {
    const health = (Status: string) => parseDockerPs([row({ Status })])[0].health;
    expect([health("Up 3 days (healthy)"), health("Up 5 seconds (health: starting)"), health("Up 2 hours (unhealthy)"), health("Up 5 weeks")]).toEqual(["healthy", "starting", "unhealthy", null]);
  });

  test("several names and a digest in the image take the first name and the plain image", () => {
    expect(parseDockerPs([row({ Names: "web,other/web", Image: "nginx@sha256:abc" })])[0]).toMatchObject({ name: "web", image: "nginx" });
  });
});

describe("planning for the Pi", () => {
  const { found, warnings } = planPi();

  test("its eleven listeners are six once IPv4 and IPv6 of a port count as one", () => {
    expect(report.listeners).toHaveLength(11);
    expect(piSnapshot().listeners.map((l) => l.port).sort((x, y) => x - y)).toEqual([22, 631, 2222, 5000, 9001, 41963]);
  });

  test("services on the Pi are found with host rpi, a key of their own, and the Pi as their dependency", () => {
    expect(byKey(found, "rpi:5000")).toMatchObject({
      host: "rpi", port: 5000, container: "scraper_app_1", project: "scraper", kind: "http",
      url: `http://${ADDRESS}:5000`, sources: ["agent:rpi"], dependsOn: ["host:rpi"], exposure: "lan", tracked: false,
    });
    expect(byKey(found, "rpi:9001")).toMatchObject({ host: "rpi", container: "portainer_agent", sources: ["agent:rpi"] });
  });

  test("ssh is a TCP check on the Pi's address, and shows when the agent can name the process", () => {
    expect(byKey(found, "rpi:22")).toMatchObject({ kind: "tcp", url: null, host: "rpi", port: 22, bindAddress: "0.0.0.0", title: "port 22", hidden: true });
    const named = { ...report, listeners: report.listeners.map((l: { port: number }) => (l.port === 22 ? { ...l, process: "sshd" } : l)) };
    const { found: withNames } = planTargets(piSnapshot(named), new Map(), { name: "rpi", address: ADDRESS });
    expect(byKey(withNames, "rpi:22")).toMatchObject({ title: "sshd", hidden: false });
  });

  test("a container with no port is checked through the report, under a key that names the host", () => {
    expect(byKey(found, "rpi:container:kali")).toMatchObject({ kind: "container", host: "rpi", container: "kali", sources: ["agent:rpi"] });
  });

  test("loopback listeners are left out: the mini cannot reach them to check", () => {
    expect(found.filter((f) => f.port === 631 || f.port === 41963)).toEqual([]);
  });

  test("a port nobody named is found but hidden, like the mini's", () => {
    expect(byKey(found, "rpi:2222")).toMatchObject({ title: "port 2222", hidden: true });
  });

  test("the portainer agent on every address is an admin warning named for the Pi, so it cannot clash with the mini's port", () => {
    expect(warnings.map((w) => w.key)).toEqual(["admin-open-lan:rpi:9001"]);
    expect(warnings[0]).toMatchObject({ targetKey: "rpi:9001", kind: "admin-open-lan" });
  });
});

describe("discovery with a report", () => {
  beforeEach(() => {
    clearMonitoring();
    givenMini(child.execFile);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("the Pi's services join the mini's, and the mini's warnings keep their keys", async () => {
    acceptReport("rpi", report, ADDRESS, NOW);
    const run = await runDiscovery(NOW);
    expect(getTarget("rpi:5000")).toMatchObject({ host: "rpi", container: "scraper_app_1", url: `http://${ADDRESS}:5000`, sources: ["agent:rpi"] });
    expect(getTarget("rpi:22")).toMatchObject({ kind: "tcp", host: "rpi" });
    expect(getTarget("rpi:container:kali")).toMatchObject({ kind: "container" });
    expect(getTarget("mini:5433")).toMatchObject({ host: "mini" });
    const keys = db.select().from(monitorWarnings).all().map((w) => w.key);
    expect(keys).toContain("admin-open-lan:rpi:9001");
    expect(keys).toContain("database-open-lan:5433");
    expect(run.hosts).toHaveLength(1);
  });

  test("the Ports view lists the Pi's ports next to the mini's, with the host", async () => {
    acceptReport("rpi", report, ADDRESS, NOW);
    const run = await runDiscovery(NOW);
    const ports = buildPorts(run, buildTargetRows(NOW));
    const pi = ports.filter((p) => p.host === "rpi");
    expect(pi.map((p) => p.port)).toEqual([22, 631, 2222, 5000, 9001, 41963]);
    expect(pi.find((p) => p.port === 5000)).toMatchObject({ owner: "scraper_app_1", targetKey: "rpi:5000", exposure: "lan" });
    expect(pi.find((p) => p.port === 631)).toMatchObject({ bind: "127.0.0.1", exposure: "local", targetKey: null });
    expect(ports.filter((p) => p.host === "mini").length).toBeGreaterThan(50);
    expect(lastDiscovery()?.hosts[0].host).toBe("rpi");
  });

  test("without a fresh report nothing of the Pi is created", async () => {
    acceptReport("rpi", report, ADDRESS, NOW - 10 * MINUTE);
    await runDiscovery(NOW);
    expect(db.select().from(monitorTargets).all().filter((t) => t.host === "rpi" && t.kind !== "host")).toEqual([]);
  });

  test("a Pi that goes silent keeps its targets and warnings, because silence says nothing about what is there", async () => {
    acceptReport("rpi", report, ADDRESS, NOW);
    await runDiscovery(NOW);
    for (let run = 1; run <= MISSED_RUNS_TO_RETIRE + 1; run++) await runDiscovery(NOW + run * 10 * MINUTE);
    expect(getTarget("rpi:5000")).toMatchObject({ retiredAt: null, missedRuns: 0 });
    expect(db.select().from(monitorWarnings).all().find((w) => w.key === "admin-open-lan:rpi:9001")).toMatchObject({ resolvedAt: null });
  });

  test("a container that leaves the Pi's reports is retired after three runs, and its warning resolves when the port closes", async () => {
    acceptReport("rpi", report, ADDRESS, NOW);
    await runDiscovery(NOW);
    const without = { ...report, containers: report.containers.filter((c: { Names: string }) => c.Names !== "kali" && c.Names !== "portainer_agent") };
    for (let run = 1; run <= MISSED_RUNS_TO_RETIRE; run++) {
      acceptReport("rpi", without, ADDRESS, NOW + run * MINUTE);
      await runDiscovery(NOW + run * MINUTE);
    }
    expect(getTarget("rpi:container:kali")?.retiredAt).not.toBeNull();
    expect(getTarget("rpi:5000")?.retiredAt).toBeNull();
    expect(db.select().from(monitorWarnings).all().find((w) => w.key === "admin-open-lan:rpi:9001")?.resolvedAt).not.toBeNull();
  });
});

describe("a container on another host", () => {
  test("is up while the host's latest report says it runs, and down when it stops, goes missing or the host is silent", () => {
    acceptReport("rpi", report, ADDRESS, NOW);
    expect(checkReportedContainer("rpi", "kali", NOW + MINUTE)).toMatchObject({ ok: true });
    expect(checkReportedContainer("rpi", "kali", NOW + 4 * MINUTE)).toMatchObject({ ok: false, error: "No report from rpi" });
    expect(checkReportedContainer("rpi", "nope", NOW + MINUTE)).toMatchObject({ ok: false, error: "Container is gone" });
    const stopped = { ...report, containers: report.containers.map((c: { Names: string }) => (c.Names === "kali" ? { ...c, State: "exited" } : c)) };
    acceptReport("rpi", stopped, ADDRESS, NOW + MINUTE);
    expect(checkReportedContainer("rpi", "kali", NOW + MINUTE)).toMatchObject({ ok: false, error: "Container is exited" });
    const unhealthy = { ...report, containers: report.containers.map((c: { Names: string }) => (c.Names === "kali" ? { ...c, Status: "Up 1 hour (unhealthy)" } : c)) };
    acceptReport("rpi", unhealthy, ADDRESS, NOW + 2 * MINUTE);
    expect(checkReportedContainer("rpi", "kali", NOW + 2 * MINUTE)).toMatchObject({ ok: false, error: "Container is unhealthy" });
    expect(checkReportedContainer("macbook", "kali", NOW)).toMatchObject({ ok: false, error: "No report from macbook" });
  });
});
