import { expect, test } from "vitest";
import { parseDnsRecords, parseIngress } from "../../src/monitoring/cloudflare.js";
import {
  dedupeListeners, listenerTitle, parseContainers, parseDockerSpace, parseHomeIp, parseLsof, parseRoutes, parseSs, parseTailnetIps, unitFromCgroup,
} from "../../src/monitoring/sources.js";
import { fixture, json } from "./fixtures.js";

const routes = () => parseRoutes(json("traefik-routers.json"), json("traefik-services.json"), json("traefik-middlewares.json"));
const containers = () => parseContainers(json("docker-inspect.json"));
const routeOf = (host: string) => routes().find((r) => r.hosts.includes(host))!;

test("traefik: one route per router with its hostnames, backend and allow-list; Traefik's own routers are left out", () => {
  expect(json("traefik-routers.json")).toHaveLength(38);
  expect(routes()).toHaveLength(35); // api, dashboard and noop are Traefik's own
  expect(routeOf("recipesapi.apps.example.net")).toMatchObject({ backend: { host: "172.18.0.8", port: 6000 }, allowedRanges: null, pathScoped: false });
  expect(routeOf("portfolio.home.example.com").backend).toEqual({ host: "10.0.2.248", port: 4123 });
  expect(routeOf("api.apps.example.net").backend).toEqual({ host: "10.0.2.168", port: 8085 });
});

test("traefik: a rule with several hosts gives all of them, and a path in the rule marks the route as partial", () => {
  const landing = routes().find((r) => r.hosts.includes("www.apps.example.org"))!;
  expect(landing.hosts).toEqual(["apps.example.org", "www.apps.example.org", "app.apps.example.net", "apps.example.net"]);
  expect(landing.pathScoped).toBe(true);
  expect(routeOf("recipes.apps.example.org").hosts).toEqual(["recipes.apps.example.org", "recipes.apps.example.net"]);
  expect(routes().filter((r) => r.hosts.includes("images.apps.example.net")).map((r) => r.pathScoped).sort()).toEqual([false, true]);
});

test("traefik: the allow-list of a router's middleware comes through, and other middlewares are ignored", () => {
  expect(routeOf("bookmarks.home.example.com").allowedRanges).toEqual(["100.64.0.0/10", "172.18.0.0/16"]);
  expect(routeOf("board.home.example.com").allowedRanges).toContain("10.0.2.0/24");
  expect(routeOf("fitnessapi.home.example.com").allowedRanges).toBeNull(); // has a headers middleware only
});

test("docker: name, image without digest, compose project, state, health, restarts and address", () => {
  const byName = Object.fromEntries(containers().map((c) => [c.name, c]));
  expect(Object.keys(byName)).toHaveLength(47);
  expect(byName.recipes_db).toMatchObject({ image: "pgvector/pgvector:pg16", project: "shop-recipes", state: "running", health: "healthy", restarts: 0, oomKilled: false });
  expect(byName.recipes_db.ips).toEqual([expect.stringMatching(/^172\./)]);
  expect(byName.minio.image).toBe("minio/minio");
  expect(byName["status-app_tiles"]).toMatchObject({ state: "exited", project: null, ips: [], ports: [] });
  expect(byName.redis.health).toBeNull();
});

test("docker: a published port appears once although Docker lists IPv4 and IPv6, with the container's own port", () => {
  const byName = Object.fromEntries(containers().map((c) => [c.name, c]));
  expect(byName.recipes_db.ports).toEqual([{ port: 5433, containerPort: 5432, bind: "0.0.0.0" }]);
  expect(byName.portainer.ports.map((p) => [p.port, p.containerPort])).toEqual([[8000, 8000], [9000, 9000], [9443, 9443]]);
  expect(byName.recipes_landing.ports).toEqual([]); // exposed to the Docker network only
});

test("docker: an empty host IP means every address, and UDP is ignored", () => {
  const [c] = parseContainers([{
    Name: "/x", RestartCount: 2, State: { Status: "running", OOMKilled: true },
    Config: { Image: "x:1" },
    NetworkSettings: { Ports: { "53/udp": [{ HostIp: "0.0.0.0", HostPort: "53" }], "80/tcp": [{ HostIp: "", HostPort: "8080" }] }, Networks: { a: { IPAddress: "" }, b: { IPAddress: "172.20.0.4" } } },
  }]);
  expect(c).toMatchObject({ ports: [{ port: 8080, containerPort: 80, bind: "0.0.0.0" }], ips: ["172.20.0.4"], restarts: 2, oomKilled: true, project: null });
});

test("docker: a container on two networks has an address on each, which Traefik may name either of", () => {
  const byName = Object.fromEntries(containers().map((c) => [c.name, c]));
  expect(byName.recipes_api.ips).toEqual(["172.19.0.3", "172.18.0.8"]);
  expect(byName["shop-app-app-1"].ips).toContain("172.18.0.9");
});

test("ss: every address form, with process and pid where ss could see them", () => {
  const listeners = parseSs(fixture("ss-tlnp.txt"));
  expect(listeners).toHaveLength(93);
  expect(listeners).toContainEqual({ bind: "0.0.0.0", port: 3002, pid: 2927876, comm: "MainThread" });
  expect(listeners).toContainEqual({ bind: "0.0.0.0", port: 3010, pid: null, comm: null });
  expect(listeners).toContainEqual({ bind: "127.0.0.53", port: 53, pid: null, comm: null }); // %lo dropped
  expect(listeners).toContainEqual({ bind: "100.64.0.42", port: 4130, pid: 1290514, comm: "next-server (v1" });
  expect(listeners).toContainEqual({ bind: "::", port: 3010, pid: null, comm: null });
  expect(listeners).toContainEqual({ bind: "::1", port: 631, pid: null, comm: null });
  expect(listeners).toContainEqual({ bind: "0.0.0.0", port: 4999, pid: 2482392, comm: "next-server (v1" }); // *:4999
  expect(listeners).toContainEqual({ bind: "fd7a:115c:a1e0::42", port: 8443, pid: null, comm: null });
});

test("ss: the IPv4 and IPv6 listeners of one socket become one row; the same port on another reach stays", () => {
  const tailnet = ["100.64.0.42", "fd7a:115c:a1e0::42"];
  const rows = dedupeListeners(parseSs(fixture("ss-tlnp.txt")), tailnet);
  expect(rows.filter((l) => l.port === 5433)).toHaveLength(1);
  expect(rows.filter((l) => l.port === 8443)).toHaveLength(1);
  expect(rows.filter((l) => l.port === 631)).toHaveLength(1);
  const both = dedupeListeners([{ port: 80, bind: "127.0.0.1" }, { port: 80, bind: "100.1.2.3" }, { port: 80, bind: "::1" }]);
  expect(both).toEqual([{ port: 80, bind: "127.0.0.1" }, { port: 80, bind: "100.1.2.3" }]);
});

test("a service unit comes from the cgroup path, system or user, and never the user manager", () => {
  expect(unitFromCgroup("0::/system.slice/chomp.service\n")).toBe("chomp.service");
  expect(unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/site-index.service\n")).toBe("site-index.service");
  expect(unitFromCgroup("0::/system.slice/system-code\\x2dserver.slice/code-server@testuser.service\n")).toBe("code-server@testuser.service");
  expect(unitFromCgroup("0::/user.slice/user-1000.slice/session-69755.scope\n")).toBeNull();
  expect(unitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/init.scope\n")).toBeNull();
});

test("a listener is named by its unit, then its directory, then its process; ss's cut-off names are not used", () => {
  const next = { bind: "0.0.0.0", port: 4127, pid: 1, comm: "next-server (v1" };
  expect(listenerTitle(next, "site-index.service", "/home/x/code/site-index")).toBe("site-index");
  expect(listenerTitle(next, null, "/home/x/code/site-index")).toBe("site-index");
  expect(listenerTitle(next, null, "/home/x/queue-app/releases/20260901T161952Z-51d9ed8")).toBe("queue-app");
  expect(listenerTitle(next, null, "/")).toBe("next-server");
  expect(listenerTitle({ ...next, comm: "python3" }, null, null)).toBe("python3");
  expect(listenerTitle({ ...next, comm: null, pid: null }, null, null)).toBe("port 4127");
});

test("docker space: reclaimable bytes per type, in SI units, without the percentage", () => {
  expect(parseDockerSpace(fixture("docker-system-df.txt"))).toEqual([
    { type: "Images", reclaimableBytes: 120.2e9 },
    { type: "Containers", reclaimableBytes: 77.84e6 },
    { type: "Local Volumes", reclaimableBytes: 531e6 },
    { type: "Build Cache", reclaimableBytes: 21.34e9 },
  ]);
});

test("the home IP comes from Cloudflare's trace, the tailnet addresses from tailscale status", () => {
  expect(parseHomeIp(fixture("cdn-cgi-trace.txt"))).toBe("203.0.113.7");
  expect(parseHomeIp("fl=1\nh=x\n")).toBeNull();
  expect(parseTailnetIps(json("tailscale-status.json"))).toEqual(["100.64.0.42", "fd7a:115c:a1e0::42"]);
});

test("cloudflare: ingress rules with a hostname, with their path, and not the catch-all", () => {
  const rules = parseIngress(json("cloudflare-tunnel.json").result);
  expect(rules).toHaveLength(32);
  expect(rules).toContainEqual({ hostname: "webhooks.apps.example.net", path: "/api/webhooks/receive/*", service: "http://localhost:3002" });
  expect(rules).toContainEqual({ hostname: "api.service.example.org", path: null, service: "https://localhost:443" });
  expect(rules.some((r) => r.service.startsWith("http_status"))).toBe(false);
  expect(parseIngress({ config: null })).toEqual([]);
});

test("cloudflare: DNS records keep address and alias records only, with the proxied flag", () => {
  const records = parseDnsRecords([...json("cloudflare-dns-home.json").result, { name: "x.test", type: "TXT", content: "v=spf1", proxied: false }]);
  expect(records.some((r) => r.type === "TXT")).toBe(false);
  expect(records).toContainEqual({ name: "direct.home.example.com", type: "A", content: "203.0.113.7", proxied: false });
  expect(records).toContainEqual({ name: "journeys.home.example.com", type: "CNAME", content: "00000000-0000-4000-8000-000000000010.cfargotunnel.com", proxied: true });
});

test("lsof -Fpcn on macOS gives each socket with its process, and * as every address", () => {
  const out = "p1257\ncControlCenter\nf9\nn*:7000\nf10\nn*:7000\np2922\ncPython\nf4\nn100.64.0.9:8472\nf5\nn[::1]:5000\n";
  expect(parseLsof(out)).toEqual([
    { bind: "0.0.0.0", port: 7000, pid: 1257, comm: "ControlCenter" },
    { bind: "0.0.0.0", port: 7000, pid: 1257, comm: "ControlCenter" },
    { bind: "100.64.0.9", port: 8472, pid: 2922, comm: "Python" },
    { bind: "::1", port: 5000, pid: 2922, comm: "Python" },
  ]);
});
