import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile: child.execFile }));

import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import { runDiscovery } from "../../src/monitoring/run.js";
import { getTarget } from "../../src/monitoring/store.js";
import monitoringRoutes from "../../src/routes/monitoring.js";
import { givenMini } from "./mini-mocks.js";
import { addTarget, clearMonitoring, MINUTE, NOW, serve } from "./helpers.js";

let api: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/monitoring", monitoringRoutes);
  api = await serve(app);
});
afterAll(() => api.close());
beforeEach(() => {
  clearMonitoring();
  saveSecret("CLOUDFLARE_API_TOKEN", "test-token");
  saveSecret("CLOUDFLARE_ACCOUNT_ID", "0000000000000000000000000000abcdef");
  givenMini(child.execFile);
});
afterEach(() => {
  vi.unstubAllGlobals();
  deleteSecret("CLOUDFLARE_API_TOKEN");
  deleteSecret("CLOUDFLARE_ACCOUNT_ID");
});

const get = async (path: string) => (await fetch(`${api.url}/api/monitoring${path}`)).json();
const patch = (key: string, body: unknown) =>
  fetch(`${api.url}/api/monitoring/targets/${encodeURIComponent(key)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rowOf = async (key: string) => (await get("/targets")).targets.find((t: { key: string }) => t.key === key);

// First: nothing has run yet in this file.
test("before the first run, discovery has nothing to report and the views are empty", async () => {
  expect(await get("/discovery")).toEqual({ lastRunAt: null, durationMs: null, sources: [], summary: null });
  expect(await get("/ports")).toEqual({ discoveredAt: null, ports: [], outside: null });
  const { levels, other } = await get("/exposure");
  expect(levels.map((l: { level: string }) => l.level)).toEqual(["public-direct", "public-tunnel", "lan", "tailnet", "local"]);
  expect(levels.every((l: { targets: unknown[] }) => l.targets.length === 0)).toBe(true);
  expect(other).toEqual([]);
});

describe("after a run", () => {
  beforeEach(async () => { await runDiscovery(NOW); });

  test("GET /discovery says when it ran and how each source answered", async () => {
    const body = await get("/discovery");
    expect(body.lastRunAt).toBe(new Date(NOW).toISOString());
    expect(body.sources.map((s: { source: string }) => s.source)).toEqual(["traefik", "cloudflare", "dns", "docker", "listener", "tailscale", "home-ip", "docker-space", "outside-probe"]);
    // The outside probe has no Cloudflare KV settings in this test, so it is skipped and says so.
    expect(body.sources.filter((s: { state: string }) => s.state !== "ok")).toEqual([
      { source: "outside-probe", state: "skipped", message: expect.stringContaining("Not configured"), count: 0 },
    ]);
    expect(body.summary).toMatchObject({ retired: 0, restored: 0 });
  });

  test("GET /targets rows carry exposure, bind, container, image, unit, sources, hidden, retired and warnings", async () => {
    expect(await rowOf("mini:5433")).toMatchObject({
      title: "recipes_db", kind: "tcp", exposure: "lan", bind: "0.0.0.0", port: 5433, container: "recipes_db", image: "pgvector/pgvector:pg16",
      unit: null, sources: ["docker"], dependsOn: ["host:mini"], hidden: false, retired: false, tracked: false, project: "shop-recipes",
      containerState: { state: "running", health: "healthy", restarts: 0, oomKilled: false },
      warnings: [{ key: "database-open-lan:5433", kind: "database-open-lan", text: "recipes_db is a database or cache, and port 5433 is open to the LAN." }],
    });
    const row = await rowOf("mini:5433");
    expect(row).not.toHaveProperty("containerInfo");
    expect(JSON.stringify(row)).not.toMatch(/172\.\d+\.\d+\.\d+/); // the container address stays inside
  });

  test("hidden and retired targets are listed, flagged, and left out of the verdict; the overview lists open warnings", async () => {
    expect(await rowOf("mini:5126")).toMatchObject({ hidden: true, retired: false });
    addTarget({ key: "old-site", tracked: true, retiredAt: "2026-11-01T00:00:00.000Z", status: "down" });
    expect(await rowOf("old-site")).toMatchObject({ retired: true });
    const overview = await get("/overview");
    expect(overview.attention.map((a: { key: string }) => a.key)).not.toContain("old-site");
    const { targets } = await get("/targets");
    expect(overview.counts.total).toBe(targets.filter((t: { tracked: boolean; hidden: boolean; retired: boolean }) => t.tracked && !t.hidden && !t.retired).length);
    expect(overview.counts.total).toBe(43); // the hostnames Traefik or the tunnel route
    // The overview also lists the open warnings.
    expect(overview.warnings.length).toBeGreaterThanOrEqual(13);
    expect(overview.warnings).toContainEqual(expect.objectContaining({ key: "tunnel-without-router:ideas.home.example.com", targetKey: "ideas.home.example.com", kind: "tunnel-without-router" }));
  });

  test("GET /ports lists every listener once, with its owner, reach and the target that checks it", async () => {
    const { discoveredAt, ports } = await get("/ports");
    expect(discoveredAt).toBe(new Date(NOW).toISOString());
    const byPort = new Map<number, Record<string, unknown>>(ports.map((p: { port: number }) => [p.port, p]));
    expect(byPort.size).toBe(ports.length); // one row per port
    expect(ports.map((p: { port: number }) => p.port)).toEqual([...ports.map((p: { port: number }) => p.port)].sort((a, b) => a - b));

    expect(byPort.get(5433)).toEqual({
      host: "mini", port: 5433, bind: "0.0.0.0", exposure: "lan", owner: "recipes_db", container: "recipes_db", image: "pgvector/pgvector:pg16", unit: null,
      targetKey: "mini:5433", targetTitle: "recipes_db",
    });
    expect(byPort.get(4130)).toMatchObject({ bind: "100.64.0.42", exposure: "tailnet", targetKey: "bookmarks.home.example.com" }); // the hostname speaks for the port
    expect(byPort.get(4127)).toMatchObject({ exposure: "lan", targetKey: "mini:4127" });
    expect(byPort.get(6379)).toMatchObject({ owner: "redis", exposure: "lan" });

    // Ports nobody claims have no target.
    const unclaimed = ports.filter((p: { targetKey: string | null }) => p.targetKey === null).map((p: { port: number }) => p.port);
    expect(unclaimed).toEqual(expect.arrayContaining([22, 53, 631, 11434, 44599, 51810]));
    expect(unclaimed).not.toContain(5433);
  });

  test("GET /exposure groups the visible targets by level, widest first, with each level's warnings", async () => {
    const { levels, other } = await get("/exposure");
    const level = (name: string) => levels.find((l: { level: string }) => l.level === name);
    const keys = (name: string) => level(name).targets.map((t: { key: string }) => t.key);

    expect(levels.map((l: { level: string; label: string }) => l.label)).toEqual(["Public, direct", "Public, tunnel", "LAN", "Tailnet", "Local"]);
    expect(keys("public-direct")).toEqual(["direct.home.example.com"]);
    expect(keys("public-tunnel")).toEqual(expect.arrayContaining(["journeys.home.example.com", "webhooks.apps.example.net", "coop.home.example.com"]));
    expect(keys("tailnet")).toEqual(expect.arrayContaining(["bookmarks.home.example.com", "invoices.home.example.com"]));
    expect(keys("lan")).toEqual(expect.arrayContaining(["mini:5433", "mini:6379", "board.home.example.com"]));
    expect(keys("local")).toEqual(expect.arrayContaining(["container:fitness_db", "mini:4179"]));
    expect(keys("lan")).not.toContain("mini:5126"); // hidden
    expect(level("lan").targets.find((t: { key: string }) => t.key === "mini:5433")).toEqual({
      key: "mini:5433", title: "recipes_db", state: "stale", tracked: false, port: 5433, bind: "0.0.0.0", container: "recipes_db", outside: null,
    });

    expect(level("lan").warnings.map((w: { kind: string }) => w.kind)).toContain("database-open-lan");
    expect(level("lan").warnings.map((w: { kind: string }) => w.kind)).toContain("admin-open-lan");
    expect(level("public-tunnel").warnings.map((w: { key: string }) => w.key)).toContain("tunnel-without-router:ideas.home.example.com");
    expect(level("public-direct").warnings.map((w: { key: string }) => w.key)).toEqual(["public-direct:direct.home.example.com"]);
    expect(level("local").warnings).toEqual([]);
    expect(other.map((w: { key: string }) => w.key)).toEqual(["docker-reclaimable"]);
  });

  test("an edit by hand survives the next run, through the API", async () => {
    expect((await patch("mini:5433", { title: "recipes database", tracked: true, project: "recipes" })).status).toBe(200);
    await runDiscovery(NOW + 5 * MINUTE);
    expect(await rowOf("mini:5433")).toMatchObject({ title: "recipes database", tracked: true, project: "recipes", container: "recipes_db" });
  });
});

describe("PATCH /targets/:key", () => {
  beforeEach(() => { addTarget({ key: "web", title: "Web", project: "old", tracked: false }); });

  test("changes the fields sent and answers with the new row, leaving the others alone", async () => {
    await patch("web", { notes: "n" });
    expect(getTarget("web")).toMatchObject({ title: "Web", project: "old", tracked: false, notes: "n", userFields: ["notes"] });

    const res = await patch("web", { tracked: true, hidden: true, title: "  My web  ", project: "Chomp", notes: "Behind the VPN", expectedStatus: 401 });
    expect(res.status).toBe(200);
    expect((await res.json()).target).toMatchObject({ key: "web", tracked: true, hidden: true, title: "My web", project: "Chomp", notes: "Behind the VPN", expectedStatus: 401 });
    expect(getTarget("web")!.userFields.sort()).toEqual(["expectedStatus", "hidden", "notes", "project", "title", "tracked"]);
  });

  test("clears project, notes and the expected status with null or an empty string", async () => {
    await patch("web", { project: "p", notes: "n", expectedStatus: 403 });
    await patch("web", { project: "", notes: "   ", expectedStatus: null });
    expect(getTarget("web")).toMatchObject({ project: null, notes: null, expectedStatus: null });
    await patch("web", { project: null });
    expect(getTarget("web")!.project).toBeNull();
  });

  test("an unknown key is 404", async () => {
    const res = await patch("nope", { tracked: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Target not found" });
  });

  test("bad input is 400, says which field, and changes nothing", async () => {
    const bad: [unknown, string][] = [
      [{}, "Nothing to change"],
      [{ colour: "red" }, "colour"],
      [{ url: "https://evil.example" }, "url"],
      [{ tracked: "yes" }, "tracked"],
      [{ hidden: 1 }, "hidden"],
      [{ title: "" }, "title"],
      [{ title: "   " }, "title"],
      [{ title: "x".repeat(121) }, "title"],
      [{ title: null }, "title"],
      [{ project: "x".repeat(61) }, "project"],
      [{ notes: "x".repeat(2001) }, "notes"],
      [{ expectedStatus: 99 }, "expectedStatus"],
      [{ expectedStatus: 600 }, "expectedStatus"],
      [{ expectedStatus: 200.5 }, "expectedStatus"],
      [{ expectedStatus: "200" }, "expectedStatus"],
      [[1, 2], "body"],
    ];
    for (const [body, field] of bad) {
      const res = await patch("web", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toContain(field);
    }
    expect(getTarget("web")).toMatchObject({ title: "Web", project: "old", tracked: false, hidden: false, userFields: [] });
  });
});
