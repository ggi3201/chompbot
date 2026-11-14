import { expect, test } from "vitest";
import { evaluateWarnings, restartsLastHour, type WarningInput } from "../../src/monitoring/warnings.js";

const empty: WarningInput = { ports: [], tunnelWithoutRouter: [], directHostnames: [], dockerSpace: [], containers: [] };
const port = (over: Partial<WarningInput["ports"][number]>) => ({ targetKey: "mini:5433", port: 5433, bind: "0.0.0.0", image: "postgres:17", label: "recipes_db", ...over });
const kinds = (input: Partial<WarningInput>) => evaluateWarnings({ ...empty, ...input }).map((f) => f.key);

test("a database or cache on every address is open to the LAN, by image, by process name, or on the IPv6 wildcard", () => {
  for (const image of ["postgres:17-alpine", "pgvector/pgvector:pg16", "redis:alpine", "mysql:8", "mariadb:11", "mongo:7", "clickhouse/clickhouse-server:24.3", "minio/minio"]) {
    expect(kinds({ ports: [port({ image })] })).toEqual(["database-open-lan:5433"]);
  }
  expect(kinds({ ports: [port({ bind: "::" })] })).toEqual(["database-open-lan:5433"]);
  expect(kinds({ ports: [port({ image: null, label: "redis-server", port: 6379 })] })).toEqual(["database-open-lan:6379"]);
  expect(evaluateWarnings({ ...empty, ports: [port({})] })[0]).toMatchObject({ kind: "database-open-lan", targetKey: "mini:5433" });
});

test("the same database bound to loopback or the tailnet is not a warning, and neither is an ordinary web app", () => {
  expect(kinds({ ports: [port({ bind: "127.0.0.1" }), port({ port: 5434, bind: "100.64.0.42" })] })).toEqual([]);
  expect(kinds({ ports: [port({ image: "nginx:alpine", label: "web" })] })).toEqual([]);
});

test("an admin UI on every address is open to the LAN: portainer, dashy, kuma, code-server", () => {
  const admin = (image: string | null, label: string, p: number) => port({ image, label, port: p, targetKey: `mini:${p}` });
  expect(kinds({ ports: [
    admin("portainer/portainer-ce:latest", "portainer", 9000), admin("lissy93/dashy:latest", "dashy", 9090),
    admin("louislam/uptime-kuma:1", "uptime-kuma", 3001), admin(null, "code-server@testuser", 8080),
  ] })).toEqual(["admin-open-lan:9000", "admin-open-lan:9090", "admin-open-lan:3001", "admin-open-lan:8080"]);
  expect(kinds({ ports: [port({ image: "portainer/portainer-ce", label: "portainer", bind: "127.0.0.1" })] })).toEqual([]);
});

test("a tunnel route with no Traefik router, and a hostname on the home IP, are warnings on the hostname", () => {
  expect(evaluateWarnings({ ...empty, tunnelWithoutRouter: ["ideas.home.example.com"] })).toEqual([expect.objectContaining({
    key: "tunnel-without-router:ideas.home.example.com", kind: "tunnel-without-router", targetKey: "ideas.home.example.com",
  })]);
  expect(kinds({ directHostnames: ["direct.home.example.com"] })).toEqual(["public-direct:direct.home.example.com"]);
});

test("Docker space over 30 GB is a warning that says where it is; 30 GB or less is not", () => {
  const space = (images: number, cache: number) => [
    { type: "Images", reclaimableBytes: images }, { type: "Containers", reclaimableBytes: 78e6 }, { type: "Build Cache", reclaimableBytes: cache },
  ];
  expect(evaluateWarnings({ ...empty, dockerSpace: space(120.2e9, 21.34e9) })).toEqual([
    { key: "docker-reclaimable", kind: "docker-reclaimable", targetKey: null, text: "Docker can free 142 GB (images 120 GB, build cache 21 GB)." },
  ]);
  expect(kinds({ dockerSpace: space(20e9, 9.9e9) })).toEqual([]);
  expect(kinds({ dockerSpace: space(20e9, 10.1e9) })).toEqual(["docker-reclaimable"]);
});

test("more than three restarts in an hour is a warning, three is not; an OOM kill is always one", () => {
  const container = (name: string, restartsLastHour: number, oomKilled = false) => ({ name, targetKey: `mini:${name}`, restartsLastHour, oomKilled });
  expect(kinds({ containers: [container("a", 3), container("b", 4), container("c", 0, true)] })).toEqual(["container-restarts:b", "container-oom:c"]);
  expect(evaluateWarnings({ ...empty, containers: [container("b", 5)] })[0]).toMatchObject({ targetKey: "mini:b", text: "b restarted 5 times in the last hour." });
});

test("restarts in the last hour: the counter now against its value an hour ago", () => {
  const HOUR = 3_600_000;
  const now = 10 * HOUR;
  expect(restartsLastHour([], now)).toBe(0);
  expect(restartsLastHour([{ ts: now, count: 7 }], now)).toBe(0); // first sample: nothing to compare with
  const samples = [{ ts: now - 3 * HOUR, count: 2 }, { ts: now - 0.9 * HOUR, count: 3 }, { ts: now - 0.5 * HOUR, count: 5 }, { ts: now, count: 7 }];
  expect(restartsLastHour(samples, now)).toBe(5); // 7 now, 2 when the hour began
  expect(restartsLastHour([{ ts: now - 0.5 * HOUR, count: 5 }, { ts: now, count: 9 }], now)).toBe(4); // oldest sample stands in
  expect(restartsLastHour([{ ts: now - 2 * HOUR, count: 9 }, { ts: now, count: 1 }], now)).toBe(0); // container was recreated
});
