import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile: child.execFile }));

import { db } from "../../src/db/index.js";
import { monitorWarnings, settings } from "../../src/db/schema.js";
import { collectSnapshot } from "../../src/monitoring/discover.js";
import { lastDiscovery, runDiscovery } from "../../src/monitoring/run.js";
import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import { getTarget } from "../../src/monitoring/store.js";
import { fixture, json } from "./fixtures.js";
import { enoent, givenMini, refused } from "./mini-mocks.js";
import { addTarget, clearMonitoring, MINUTE, NOW } from "./helpers.js";

let mini: ReturnType<typeof givenMini>;

beforeEach(() => {
  clearMonitoring();
  saveSecret("CLOUDFLARE_API_TOKEN", "test-token");
  saveSecret("CLOUDFLARE_ACCOUNT_ID", "0000000000000000000000000000abcdef");
  mini = givenMini(child.execFile);
});
afterEach(() => {
  vi.unstubAllGlobals();
  deleteSecret("CLOUDFLARE_API_TOKEN");
  deleteSecret("CLOUDFLARE_ACCOUNT_ID");
});

const states = (statuses: { source: string; state: string }[]) => Object.fromEntries(statuses.map((s) => [s.source, s.state]));

describe("collecting", () => {
  test("every source answers on the mini, and each says how much it found; a locally configured tunnel is skipped", async () => {
    const snapshot = await collectSnapshot();
    expect(snapshot.statuses).toEqual([
      { source: "traefik", state: "ok", message: null, count: 35 },
      { source: "cloudflare", state: "ok", message: null, count: 32 },
      { source: "dns", state: "ok", message: null, count: 40 },
      { source: "docker", state: "ok", message: null, count: 47 },
      { source: "listener", state: "ok", message: null, count: 93 },
      { source: "tailscale", state: "ok", message: null, count: 2 },
      { source: "home-ip", state: "ok", message: null, count: 1 },
      { source: "docker-space", state: "ok", message: null, count: 4 },
    ]);
    expect(snapshot.homeIp).toBe("203.0.113.7");
    expect(snapshot.tailnetIps).toEqual(["100.64.0.42", "fd7a:115c:a1e0::42"]);
    expect(snapshot.listeners.filter((l) => l.port === 5433)).toHaveLength(1);
    // A tunnel that is configured by a local file has no ingress to read, and is skipped.
    const asked = (vi.mocked(fetch).mock.calls as unknown[][]).map((call) => String(call[0]));
    expect(asked.filter((url) => url.includes("/configurations"))).toHaveLength(1);
  });

  test("Cloudflare without a token is skipped, and the rest carries on", async () => {
    deleteSecret("CLOUDFLARE_API_TOKEN");
    const snapshot = await collectSnapshot();
    expect(snapshot.statuses.filter((s) => s.state !== "ok")).toEqual([
      { source: "cloudflare", state: "skipped", message: "Not configured", count: 0 },
      { source: "dns", state: "skipped", message: "Not configured", count: 0 },
    ]);
    expect(snapshot.tunnel).toEqual([]);
    expect(snapshot.routes.length).toBeGreaterThan(0);
  });

  test("a token Cloudflare turns down is an error with Cloudflare's words, and only for the sources that used it", async () => {
    for (const key of [...mini.urls.keys()].filter((k) => k.includes("api.cloudflare.com"))) {
      mini.urls.set(key, new Response(JSON.stringify({ success: false, errors: [{ message: "Invalid API Token" }] }), { status: 403 }));
    }
    const snapshot = await collectSnapshot();
    expect(states(snapshot.statuses)).toMatchObject({ cloudflare: "error", dns: "error", traefik: "ok", docker: "ok" });
    expect(snapshot.statuses.find((s) => s.source === "cloudflare")!.message).toBe("Cloudflare 403: Invalid API Token");
  });

  test("a Mac with no Docker daemon, ss, Traefik or tailscale gets skipped sources, not errors and not a throw", async () => {
    mini.commands.set("docker ps -aq", enoent("docker"));
    mini.commands.set("docker system df", enoent("docker"));
    mini.commands.set("ss -tlnp", enoent("ss"));
    mini.commands.set("tailscale status --json", enoent("tailscale"));
    mini.urls.set("http://127.0.0.1:8081/api/http/routers", refused());
    mini.urls.set("http://127.0.0.1:8081/api/http/services", refused());
    mini.urls.set("http://127.0.0.1:8081/api/http/middlewares", refused());
    const snapshot = await collectSnapshot();
    expect(states(snapshot.statuses)).toMatchObject({ traefik: "skipped", docker: "skipped", listener: "skipped", tailscale: "skipped", "docker-space": "skipped" });
    expect(snapshot.statuses.find((s) => s.source === "listener")!.message).toBe("ss is not installed");
    expect(snapshot.statuses.find((s) => s.source === "traefik")!.message).toBe("Traefik is not running here");
    expect([snapshot.containers, snapshot.listeners, snapshot.routes]).toEqual([[], [], []]);
  });

  test("a failure that is not absence is an error with the program's own first line; no containers at all is fine", async () => {
    mini.commands.set("docker ps -aq", new Error("permission denied while trying to connect to the Docker daemon socket"));
    const snapshot = await collectSnapshot();
    expect(snapshot.statuses.find((s) => s.source === "docker")).toEqual({ source: "docker", state: "error", message: "permission denied while trying to connect to the Docker daemon socket", count: 0 });

    // A host with no containers is fine.
    mini.commands.set("docker ps -aq", "");
    const empty = await collectSnapshot();
    expect(empty.statuses.find((s) => s.source === "docker")).toMatchObject({ state: "ok", count: 0 });
  });

  test("Traefik that answers with an error, or the home IP lookup that fails, is an error", async () => {
    mini.urls.set("http://127.0.0.1:8081/api/http/routers", new Response("nope", { status: 500 }));
    mini.urls.set("https://cloudflare.com/cdn-cgi/trace", new Response("no ip here", { status: 200 }));
    const snapshot = await collectSnapshot();
    expect(snapshot.statuses.find((s) => s.source === "traefik")).toMatchObject({ state: "error", message: "Traefik answered 500" });
    expect(snapshot.statuses.find((s) => s.source === "home-ip")).toMatchObject({ state: "error", message: "cloudflare.com did not say the IP" });
    expect(snapshot.homeIp).toBeNull();
  });
});

describe("a run", () => {
  test("creates the targets, warns, and remembers what it saw; a second run changes nothing", async () => {
    const first = await runDiscovery(NOW);
    expect(first.summary).toMatchObject({ created: expect.any(Number), retired: 0 });
    expect(first.summary.created).toBeGreaterThan(100);
    expect(getTarget("bookmarks.home.example.com")).toMatchObject({ exposure: "tailnet", tracked: true, bindAddress: "100.64.0.42", port: 4130, sources: ["traefik"] });
    expect(getTarget("mini:5433")).toMatchObject({ kind: "tcp", exposure: "lan", tracked: false, container: "recipes_db" });
    const warnings = db.select().from(monitorWarnings).all();
    expect(warnings.map((w) => w.kind).sort()).toContain("tunnel-without-router");
    expect(warnings.filter((w) => w.kind === "database-open-lan")).toHaveLength(5);

    const second = await runDiscovery(NOW + 5 * MINUTE);
    expect(second.summary).toMatchObject({ created: 0, retired: 0, restored: 0 });
    expect(db.select().from(monitorWarnings).all()).toHaveLength(warnings.length);
    expect(lastDiscovery()).toBe(second);
    expect(second.sources.filter((s) => s.state !== "ok").map((s) => s.source)).toEqual(["outside-probe"]); // no KV settings here
  });

  test("a run writes the probe's target list to KV once, with a DNS-only host on the home IP, and again only when it changes", async () => {
    db.delete(settings).where(eq(settings.key, "monitor:probe-targets")).run(); // what an earlier run wrote
    saveSecret("CLOUDFLARE_KV_NAMESPACE_ID", "0123456789abcdef0123456789abcdef");
    const kvUrl = "https://api.cloudflare.com/client/v4/accounts/0000000000000000000000000000abcdef/storage/kv/namespaces/0123456789abcdef0123456789abcdef/values/targets";
    mini.urls.set(kvUrl, Response.json({ success: true, result: null }));
    const writes = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === kvUrl && init?.method === "PUT");

    const first = await runDiscovery(NOW);
    expect(first.sources.find((s) => s.source === "outside-probe")).toMatchObject({ state: "ok", message: "Wrote target list version 1" });
    const list = JSON.parse(String(writes()[0][1]?.body)) as { urls: { key: string }[]; homeHost: string };
    expect(list.urls.length).toBeGreaterThan(0);
    expect(list.urls.every(({ key }) => getTarget(key)?.exposure?.startsWith("public-"))).toBe(true);
    expect(list.homeHost).toMatch(/\./);

    await runDiscovery(NOW + 5 * MINUTE);
    expect(writes()).toHaveLength(1);
    deleteSecret("CLOUDFLARE_KV_NAMESPACE_ID");
    db.delete(settings).where(eq(settings.key, "monitor:probe-targets")).run();
  });

  test("a service that goes away is retired on the third run without it, and its warning is resolved", async () => {
    await runDiscovery(NOW);
    // Redis stops: its container and its listener go.
    mini.commands.set("docker inspect", JSON.stringify((json("docker-inspect.json") as { Name: string }[]).filter((c) => c.Name !== "/redis")));
    mini.commands.set("ss -tlnp", fixture("ss-tlnp.txt").split("\n").filter((line) => !line.includes(":6379 ")).join("\n"));
    for (let i = 1; i <= 2; i++) await runDiscovery(NOW + i * 5 * MINUTE);
    expect(getTarget("mini:6379")).toMatchObject({ retiredAt: null, missedRuns: 2 });
    await runDiscovery(NOW + 15 * MINUTE);
    expect(getTarget("mini:6379")!.retiredAt).not.toBeNull();
    expect(db.select().from(monitorWarnings).all().find((w) => w.key === "database-open-lan:6379")!.resolvedAt).not.toBeNull();
  });

  test("a run in which Docker fails retires nothing and resolves no Docker warning", async () => {
    await runDiscovery(NOW);
    mini.commands.set("docker ps -aq", new Error("Cannot connect to the Docker daemon"));
    mini.commands.set("docker system df", new Error("Cannot connect to the Docker daemon"));
    for (let i = 1; i <= 4; i++) await runDiscovery(NOW + i * 5 * MINUTE);
    expect(getTarget("mini:5433")).toMatchObject({ retiredAt: null, missedRuns: 0 });
    expect(db.select().from(monitorWarnings).all().filter((w) => w.resolvedAt && w.kind !== "tunnel-without-router")).toEqual([]);
    expect(lastDiscovery()!.sources.find((s) => s.source === "docker")!.state).toBe("error");
  });

  test("restarts over several runs add up to a warning, and the container's state reaches the target", async () => {
    const inspect = (restarts: number, state = "running") => JSON.stringify((json("docker-inspect.json") as { Name: string; RestartCount: number; State: object }[])
      .map((c) => (c.Name === "/atelier_api_stg" ? { ...c, RestartCount: restarts, State: { ...c.State, Status: state } } : c)));
    for (const [minute, restarts] of [[0, 1], [5, 3], [10, 6]] as const) {
      mini.commands.set("docker inspect", inspect(restarts));
      await runDiscovery(NOW + minute * MINUTE);
    }
    expect(db.select().from(monitorWarnings).all().find((w) => w.kind === "container-restarts")).toMatchObject({
      key: "container-restarts:atelier_api_stg", targetKey: "atelierapi-stg.apps.example.net", text: "atelier_api_stg restarted 5 times in the last hour.",
    });
    expect(getTarget("atelierapi-stg.apps.example.net")!.containerInfo).toMatchObject({ restarts: 6, state: "running" });
  });

  test("a warning on a hostname that joined a Kuma monitor points at the monitor", async () => {
    addTarget({ key: "ideas-kuma", title: "ideas", url: "https://ideas.home.example.com/", sources: ["kuma:5"] });
    await runDiscovery(NOW);
    expect(getTarget("ideas.home.example.com")).toBeUndefined();
    expect(db.select().from(monitorWarnings).all().find((w) => w.key === "tunnel-without-router:ideas.home.example.com")!.targetKey).toBe("ideas-kuma");
  });
});
