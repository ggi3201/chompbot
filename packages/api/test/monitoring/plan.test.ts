import { describe, expect, test } from "vitest";
import { httpUrl, planTargets, type Found } from "../../src/monitoring/discover.js";
import { miniSnapshot } from "./fixtures.js";

const plan = (overrides = {}, restarts = new Map<string, number>()) => planTargets(miniSnapshot(overrides), restarts);
const byKey = (found: Found[], key: string) => found.find((f) => f.key === key)!;

describe("hostnames", () => {
  const { found } = plan();

  test("every hostname that Traefik or the tunnel routes becomes a tracked https target", () => {
    const hostnames = found.filter((f) => f.url?.startsWith("https://"));
    expect(hostnames.filter((f) => f.tracked && f.sources.some((s) => s === "traefik" || s === "cloudflare"))).toHaveLength(hostnames.length - 1);
    expect(byKey(found, "recipesapi.apps.example.net")).toMatchObject({ kind: "http", url: "https://recipesapi.apps.example.net", tracked: true, hidden: false, title: "recipesapi.apps.example.net" });
  });

  test("a hostname on Traefik and in the tunnel remembers both, and depends on the host, Traefik and the tunnel", () => {
    expect(byKey(found, "recipesapi.apps.example.net")).toMatchObject({
      sources: ["traefik", "cloudflare"],
      dependsOn: ["host:mini", "infra:traefik", "infra:tunnel"],
      exposure: "public-tunnel",
    });
    expect(byKey(found, "board.home.example.com")).toMatchObject({ sources: ["traefik"], dependsOn: ["host:mini", "infra:traefik"] });
  });

  test("a hostname served by a container takes its container, image and compose project", () => {
    expect(byKey(found, "recipes.apps.example.org")).toMatchObject({
      container: "recipes_landing", image: "recipes-landing:latest", project: "recipes-landing", port: 3000, bindAddress: null,
      containerInfo: { state: "running", health: "healthy", restarts: 0, oomKilled: false },
    });
  });

  test("a hostname served by a host service takes its port, bind address and systemd unit", () => {
    expect(byKey(found, "portfolio.home.example.com")).toMatchObject({
      host: "mini", port: 4123, bindAddress: "0.0.0.0", systemdUnit: "portfolio-web.service", container: null, exposure: "lan",
    });
  });

  test("with no compose project, the project is the hostname's domain, so a domain's sites group together", () => {
    expect(byKey(found, "portfolio.home.example.com").project).toBe("example");
    expect(byKey(found, "board.home.example.com").project).toBe("example");
    expect(byKey(found, "api.apps.example.net").project).toBe("example"); // a backend on another machine: no container
    expect(byKey(found, "api.service.example.org").project).toBe("rocket-backend"); // the compose project wins
  });

  test("a backend on another machine keeps that machine's address as the host", () => {
    expect(byKey(found, "api.apps.example.net")).toMatchObject({ host: "10.0.2.168", port: 8085, container: null, bindAddress: null });
  });

  test("a tunnel rule that goes straight to a local port needs no Traefik router", () => {
    expect(byKey(found, "coop.home.example.com")).toMatchObject({
      sources: ["cloudflare"], port: 8644, systemdUnit: "courier-gateway.service", dependsOn: ["host:mini", "infra:tunnel"], exposure: "public-tunnel",
    });
    expect(byKey(found, "webhooks.apps.example.net")).toMatchObject({ url: "https://webhooks.apps.example.net", port: 3002, dependsOn: ["host:mini", "infra:tunnel"] });
  });

  test("a tunnel rule to Traefik with no router is kept, tracked, and depends on Traefik: it will 404", () => {
    expect(byKey(found, "ideas.home.example.com")).toMatchObject({ sources: ["cloudflare"], tracked: true, port: null, dependsOn: ["host:mini", "infra:traefik", "infra:tunnel"] });
  });

  test("of two routers for one hostname, the one that covers all of it gives the backend", () => {
    expect(byKey(found, "images.apps.example.net")).toMatchObject({ container: "minio", port: 9000 });
    expect(byKey(found, "apps.example.net")).toMatchObject({ container: "shop-app-app-1", port: 80 }); // the plain router, on the container's proxy-network address
  });

  test("a DNS record on the home IP adds a hostname that nothing routes, untracked and public direct", () => {
    expect(byKey(found, "direct.home.example.com")).toMatchObject({ sources: ["dns"], tracked: false, exposure: "public-direct", port: null });
  });

  test("exposure follows the widest reach: tunnel, LAN, or tailnet by the router's allow-list", () => {
    const exposure = Object.fromEntries(found.filter((f) => f.url?.startsWith("https://")).map((f) => [f.key, f.exposure]));
    expect(exposure["journeys.home.example.com"]).toBe("public-tunnel");
    expect(exposure["listings.home.example.com"]).toBe("lan"); // tailnet-only admits the LAN range too
    expect(exposure["bookmarks.home.example.com"]).toBe("tailnet"); // tailnet-strict, backend on the tailnet address
    expect(exposure["invoices.home.example.com"]).toBe("tailnet");
    expect(exposure["server.example-tailnet.ts.net"]).toBe("lan");
  });
});

describe("ports, containers and listeners", () => {
  const { found } = plan();

  test("a published port becomes a target named for its container, with the image and the project", () => {
    expect(byKey(found, "mini:3010")).toMatchObject({
      title: "langfuse-web", kind: "http", url: "http://127.0.0.1:3010", container: "langfuse-web", image: "langfuse/langfuse:3", port: 3010, bindAddress: "0.0.0.0",
      project: "langfuse", tracked: false, hidden: false, exposure: "lan", sources: ["docker"],
      containerInfo: { state: "running", health: null, restarts: 0, oomKilled: false, ip: expect.stringMatching(/^172\./) },
    });
  });

  test("databases and caches get a TCP check, other containers an HTTP check", () => {
    for (const key of ["mini:5433", "mini:5434", "mini:5435", "mini:5632", "mini:6379"]) expect(byKey(found, key)).toMatchObject({ kind: "tcp", url: null });
    expect(byKey(found, "mini:9090")).toMatchObject({ kind: "http", url: "http://127.0.0.1:9090" });
  });

  test("a container with no published port and no route gets a container target; one that serves a hostname does not", () => {
    expect(byKey(found, "container:langfuse-postgres")).toMatchObject({ kind: "container", exposure: "local", tracked: false, port: null, url: null });
    expect(found.some((f) => f.key === "container:recipes_landing")).toBe(false);
    expect(found.some((f) => f.key === "container:shop-app-app-1")).toBe(false); // serves apps.example.net
  });

  test("an exited container gets no target of its own", () => {
    expect(found.some((f) => f.container === "status-app_tiles")).toBe(false);
  });

  test("everything that is not a hostname is untracked, and the targets keep the mini as their host", () => {
    const rest = found.filter((f) => !f.url?.startsWith("https://"));
    expect(rest.length).toBeGreaterThan(60);
    expect(rest.every((f) => !f.tracked && f.host === "mini" && f.dependsOn.includes("host:mini"))).toBe(true);
  });

  test("a host listener takes its name from its service unit, and its exposure from its bind address", () => {
    expect(byKey(found, "mini:4127")).toMatchObject({ title: "site-index", systemdUnit: "site-index.service", exposure: "lan", sources: ["listener"], hidden: false });
    expect(byKey(found, "mini:6799")).toMatchObject({ title: "pv-files9", exposure: "local" });
    expect(byKey(found, "mini:44599")).toMatchObject({ exposure: "tailnet", bindAddress: "100.64.0.42" });
  });

  test("a port that docker publishes is a container target only, not a second one from ss", () => {
    expect(found.filter((f) => f.key === "mini:5433")).toHaveLength(1);
    expect(byKey(found, "mini:5433").sources).toEqual(["docker"]);
  });
});

describe("noise", () => {
  const { found } = plan();
  const hidden = (key: string) => byKey(found, key).hidden;

  test("a port that Traefik or the tunnel fronts is hidden: the hostname already stands for it", () => {
    for (const key of ["mini:4123", "mini:4124", "mini:4126", "mini:4128", "mini:4131", "mini:4132", "mini:8644", "mini:3002", "mini:4130", "mini:4125"]) expect(hidden(key)).toBe(true);
  });

  test("the ports of a container that serves a hostname are hidden", () => {
    for (const key of ["mini:5124", "mini:5125", "mini:5126"]) expect(hidden(key)).toBe(true);
  });

  test("of a container's several ports only the first shows", () => {
    expect([hidden("mini:80"), hidden("mini:443"), hidden("mini:8081")]).toEqual([false, true, true]);
    expect([hidden("mini:8000"), hidden("mini:9000"), hidden("mini:9443")]).toEqual([false, true, true]);
  });

  test("a listener with no name but its port number is hidden", () => {
    for (const key of ["mini:22", "mini:53", "mini:631", "mini:11434", "mini:20241"]) expect(hidden(key)).toBe(true);
  });

  test("a loopback listener in the ephemeral port range is hidden, a low one is not", () => {
    expect(hidden("mini:43205")).toBe(true);
    expect(hidden("mini:38161")).toBe(true);
    expect(hidden("mini:4179")).toBe(false);
    expect(hidden("mini:8080")).toBe(false); // code-server on loopback
  });

  test("hostnames and standalone services are never hidden", () => {
    expect(found.filter((f) => f.url?.startsWith("https://")).some((f) => f.hidden)).toBe(false);
    expect([hidden("mini:3001"), hidden("mini:6379"), hidden("mini:4127"), hidden("container:fitness_db")]).toEqual([false, false, false, false]);
  });

  test("keys are unique", () => {
    expect(new Set(found.map((f) => f.key)).size).toBe(found.length);
  });
});

describe("warnings", () => {
  const { warnings } = plan();
  const keys = warnings.map((w) => w.key);

  test("databases and caches on every address, as on the box today", () => {
    expect(keys.filter((k) => k.startsWith("database-open-lan"))).toEqual(
      expect.arrayContaining(["database-open-lan:5433", "database-open-lan:5434", "database-open-lan:5435", "database-open-lan:5632", "database-open-lan:6379"]));
  });

  test("admin UIs on every address: Portainer, Dashy and Kuma, not code-server on loopback", () => {
    expect(keys.filter((k) => k.startsWith("admin-open-lan")).sort()).toEqual(["admin-open-lan:3001", "admin-open-lan:8000", "admin-open-lan:9000", "admin-open-lan:9090", "admin-open-lan:9443"]);
  });

  test("the two tunnel hostnames with no router, not the ones that go straight to a port", () => {
    expect(keys.filter((k) => k.startsWith("tunnel-without-router")).sort()).toEqual(["tunnel-without-router:ideas.home.example.com", "tunnel-without-router:ideasapi.home.example.com"]);
  });

  test("a hostname on the home IP, and Docker space", () => {
    expect(keys).toContain("public-direct:direct.home.example.com");
    expect(keys).toContain("docker-reclaimable");
  });

  test("restarts and OOM come from the counters the run passes in, and point at the container's target", () => {
    const { warnings: more } = plan({}, new Map([["atelier_api_stg", 6]]));
    expect(more.find((w) => w.kind === "container-restarts")).toMatchObject({ key: "container-restarts:atelier_api_stg", targetKey: "atelierapi-stg.apps.example.net" });
    const oom = miniSnapshot();
    oom.containers = oom.containers.map((c) => (c.name === "redis" ? { ...c, oomKilled: true } : c));
    expect(planTargets(oom).warnings.find((w) => w.kind === "container-oom")).toMatchObject({ key: "container-oom:redis", targetKey: "mini:6379" });
  });
});

describe("a Mac with none of it", () => {
  test("empty sources give no targets and no warnings", () => {
    const { found, warnings } = plan({ routes: [], tunnel: [], dns: [], homeIp: null, containers: [], listeners: [], dockerSpace: [], tailnetIps: [] });
    expect(found).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("with only ss and Docker, the services still show and nothing is tracked", () => {
    const { found } = plan({ routes: [], tunnel: [], dns: [], homeIp: null });
    expect(found.length).toBeGreaterThan(60);
    expect(found.some((f) => f.tracked)).toBe(false);
  });
});

test("an IPv6 listener gets a URL with brackets", () => {
  expect(httpUrl("fd7a:115c:a1e0::42", 63089)).toBe("http://[fd7a:115c:a1e0::42]:63089");
  expect(httpUrl("127.0.0.1", 3010)).toBe("http://127.0.0.1:3010");
});
