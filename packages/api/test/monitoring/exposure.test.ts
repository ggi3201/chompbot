import { expect, test } from "vitest";
import { bindExposure, classify, isTailnetOnly, widest, type Reach } from "../../src/monitoring/exposure.js";

const TAILNET = ["100.64.0.42", "fd7a:115c:a1e0::42"];
const reach = (over: Partial<Reach> = {}): Reach => ({ tunnel: false, direct: false, route: null, binds: [], ...over });

test("a bind address gives its level: every address is LAN, loopback and no published port are local", () => {
  for (const bind of ["0.0.0.0", "::", "10.0.2.248", "192.168.1.5"]) expect(bindExposure(bind, TAILNET)).toBe("lan");
  for (const bind of ["127.0.0.1", "127.0.0.54", "::1"]) expect(bindExposure(bind, TAILNET)).toBe("local");
  expect(bindExposure(null, TAILNET)).toBe("local");
});

test("a Tailscale address is the tailnet, from the status or by its range", () => {
  expect(bindExposure("100.64.0.42", TAILNET)).toBe("tailnet");
  expect(bindExposure("fd7a:115c:a1e0::42", [])).toBe("tailnet");
  expect(bindExposure("100.64.0.1")).toBe("tailnet");
  expect(bindExposure("100.127.255.255")).toBe("tailnet");
  expect(bindExposure("100.128.0.1")).toBe("lan"); // outside 100.64.0.0/10
});

test("widest wins, from public direct down to local", () => {
  expect(widest(["local", "tailnet"])).toBe("tailnet");
  expect(widest(["tailnet", "lan", "local"])).toBe("lan");
  expect(widest(["lan", "public-tunnel"])).toBe("public-tunnel");
  expect(widest(["public-tunnel", "public-direct"])).toBe("public-direct");
  expect(widest([])).toBe("local");
});

test("a router that admits only tailnet and Docker ranges keeps its hostname inside the tailnet", () => {
  expect(isTailnetOnly(["100.64.0.0/10", "172.18.0.0/16"])).toBe(true);
  expect(isTailnetOnly(["100.64.0.0/10", "10.0.2.0/24", "172.18.0.0/16"])).toBe(false);
  expect(isTailnetOnly(null)).toBe(false);
  expect(isTailnetOnly([])).toBe(false);
});

test("a hostname in the tunnel is public even when its backend is only local; one on the home IP is public direct", () => {
  expect(classify(reach({ tunnel: true, route: { allowedRanges: null }, binds: [null] }))).toBe("public-tunnel");
  // A DNS record on the home IP is public direct, which beats the tunnel.
  expect(classify(reach({ direct: true, tunnel: true }))).toBe("public-direct");
  expect(classify(reach({ direct: true }))).toBe("public-direct");
});

test("a Traefik hostname is LAN, or tailnet when the router's allow-list says so", () => {
  expect(classify(reach({ route: { allowedRanges: null }, binds: [null] }))).toBe("lan");
  expect(classify(reach({ route: { allowedRanges: ["100.64.0.0/10", "10.0.2.0/24"] } }))).toBe("lan");
  expect(classify(reach({ route: { allowedRanges: ["100.64.0.0/10"] }, binds: ["100.64.0.42"] }), TAILNET)).toBe("tailnet");
  // A tailnet-only hostname whose backend listens on every address is still reachable from the LAN.
  expect(classify(reach({ route: { allowedRanges: ["100.64.0.0/10"] }, binds: ["0.0.0.0"] }), TAILNET)).toBe("lan");
});

test("a service with no route and no published port is local; one bound to the tailnet address is tailnet", () => {
  expect(classify(reach({ binds: [null] }))).toBe("local");
  expect(classify(reach({ binds: ["127.0.0.1"] }))).toBe("local");
  expect(classify(reach({ binds: ["100.64.0.42"] }), TAILNET)).toBe("tailnet");
  expect(classify(reach())).toBe("local");
});
