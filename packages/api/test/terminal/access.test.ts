import { describe, expect, test } from "vitest";
import type { IncomingMessage } from "node:http";
import { isLocalAddress, terminalAllowed } from "../../src/terminal/access.js";

function request(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { host: "chomp.example-tailnet.ts.net:8442", ...headers }, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe("who may open a terminal", () => {
  test.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["10.0.2.20", true],
    ["192.168.1.4", true],
    ["172.20.0.3", true],
    ["100.101.102.103", true],
    ["fd7a:115c:a1e0::1", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["100.128.0.1", false],
    ["2001:4860::8888", false],
  ])("%s is local: %s", (address, local) => {
    expect(isLocalAddress(address)).toBe(local);
  });

  test("a page Chomp served, over the tailnet", () => {
    expect(terminalAllowed(request("127.0.0.1", { origin: "https://chomp.example-tailnet.ts.net:8442" }))).toBe(true);
  });

  test("a page Chomp served through a proxy that rewrote the host", () => {
    expect(terminalAllowed(request("127.0.0.1", { host: "127.0.0.1:3002", "x-forwarded-host": "chomp.example-tailnet.ts.net:8442", origin: "https://chomp.example-tailnet.ts.net:8442" }))).toBe(true);
  });

  test("not a page from another site", () => {
    expect(terminalAllowed(request("127.0.0.1", { origin: "https://evil.example" }))).toBe(false);
  });

  test("not through a Cloudflare tunnel, though it connects from loopback", () => {
    expect(terminalAllowed(request("127.0.0.1", { origin: "https://chomp.example-tailnet.ts.net:8442", "cf-connecting-ip": "8.8.8.8" }))).toBe(false);
  });

  test("not from the internet", () => {
    expect(terminalAllowed(request("8.8.8.8"))).toBe(false);
  });
});
