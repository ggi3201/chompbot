import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { deleteSecret, saveSecret } from "../../src/lib/secrets.js";
import type { DnsRecord } from "../../src/monitoring/cloudflare.js";
import { PROBE_PORTS, pickHomeHost, publicUrls, syncProbeTargets } from "../../src/monitoring/probe-targets.js";
import { patchTarget, type NewTarget } from "../../src/monitoring/store.js";
import { addTarget, clearMonitoring, NOW } from "./helpers.js";

const NAMESPACE = "0123456789abcdef0123456789abcdef";
const SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_KV_NAMESPACE_ID", "MONITOR_HOME_HOST"];
const HOME_IP = "203.0.113.7";
const dns = (name: string, content: string, proxied: boolean, type = "A"): DnsRecord => ({ name, type, content, proxied });
const FACTS = { dns: [dns("home.example.com", HOME_IP, false), dns("app.example.com", "104.16.0.1", true)], homeIp: HOME_IP };

const kv = vi.fn();

function configure() {
  saveSecret("CLOUDFLARE_API_TOKEN", "test-token");
  saveSecret("CLOUDFLARE_ACCOUNT_ID", "0000000000000000000000000000abcdef");
  saveSecret("CLOUDFLARE_KV_NAMESPACE_ID", NAMESPACE);
}

beforeEach(() => {
  clearMonitoring();
  db.delete(settings).run();
  kv.mockReset();
  kv.mockImplementation(async () => Response.json({ success: true, result: null }));
  vi.stubGlobal("fetch", kv);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of SECRETS) deleteSecret(name);
});

const sent = (call = 0) => {
  const [url, init] = kv.mock.calls[call] as [string, RequestInit];
  return { url, init, value: JSON.parse(String(init.body)) as { version: number; urls: { key: string; url: string; expectedStatus?: number }[]; ports: number[]; homeHost: string } };
};

describe("the target list", () => {
  test("holds only tracked, live http targets with a web URL that the internet reaches", () => {
    const web = (key: string, extra: Partial<NewTarget> = {}) =>
      addTarget({ key, url: `https://${key}.example.com/health`, exposure: "public-tunnel", ...extra });
    web("tunnel");
    web("direct", { exposure: "public-direct" });
    web("status", { expectedStatus: 401 });
    web("lan", { exposure: "lan" });
    web("tailnet", { exposure: "tailnet" });
    web("untracked", { tracked: false });
    web("retired", { retiredAt: new Date(NOW).toISOString() });
    web("tcp", { kind: "tcp" });
    web("no-url", { url: null });
    web("ftp", { url: "ftp://files.example.com/" });
    web("garbage", { url: "not a url" });
    addTarget({ key: "unplaced", url: "https://unplaced.example.com/" });

    expect(publicUrls()).toEqual([
      { key: "direct", url: "https://direct.example.com/health" },
      { key: "status", url: "https://status.example.com/health", expectedStatus: 401 },
      { key: "tunnel", url: "https://tunnel.example.com/health" },
    ]);
  });

  test("the home host is the override, else a DNS-only record on the home IP, else the IP", () => {
    const records = [dns("zeta.example.com", HOME_IP, false), dns("proxied.example.com", HOME_IP, true), dns("*.example.com", HOME_IP, false), dns("alpha.example.com", HOME_IP, false), dns("other.example.com", "198.51.100.1", false)];
    expect(pickHomeHost({ override: "ports.example.net", dns: records, homeIp: HOME_IP })).toBe("ports.example.net");
    expect(pickHomeHost({ override: " ", dns: records, homeIp: HOME_IP })).toBe("alpha.example.com");
    expect(pickHomeHost({ override: null, dns: [dns("proxied.example.com", HOME_IP, true)], homeIp: HOME_IP })).toBe(HOME_IP);
  });
});

describe("writing to KV", () => {
  test("not configured: nothing is sent, and the status says why", async () => {
    addTarget({ key: "a", url: "https://a.example.com/", exposure: "public-tunnel" });
    expect(await syncProbeTargets(FACTS)).toMatchObject({ source: "outside-probe", state: "skipped", message: expect.stringContaining("Not configured") });
    saveSecret("CLOUDFLARE_API_TOKEN", "test-token");
    expect(await syncProbeTargets(FACTS)).toMatchObject({
      state: "skipped", message: "Not configured: deploy the Worker, then set CLOUDFLARE_KV_NAMESPACE_ID in Settings",
    });
    expect(kv).not.toHaveBeenCalled();
  });

  test("writes the list to the namespace's targets key in the Worker's format", async () => {
    configure();
    addTarget({ key: "b", url: "https://b.example.com/", exposure: "public-tunnel", expectedStatus: 401 });
    addTarget({ key: "a", url: "https://a.example.com/", exposure: "public-direct" });
    addTarget({ key: "inside", url: "http://inside.lan/", exposure: "lan" });

    expect(await syncProbeTargets(FACTS)).toEqual({ source: "outside-probe", state: "ok", message: "Wrote target list version 1", count: 2 });
    expect(kv).toHaveBeenCalledOnce();
    const { url, init, value } = sent();
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/0000000000000000000000000000abcdef/storage/kv/namespaces/${NAMESPACE}/values/targets`);
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(value).toEqual({
      version: 1,
      urls: [{ key: "a", url: "https://a.example.com/" }, { key: "b", url: "https://b.example.com/", expectedStatus: 401 }],
      ports: PROBE_PORTS,
      homeHost: "home.example.com",
    });
    expect(PROBE_PORTS).toEqual([22, 80, 443, 3001, 5433, 5434, 5435, 5632, 6379, 8000, 9000, 9443]);
  });

  test("writes once per change: an unchanged list is skipped, a changed one bumps the version", async () => {
    configure();
    addTarget({ key: "a", url: "https://a.example.com/", exposure: "public-tunnel" });
    await syncProbeTargets(FACTS);
    expect(await syncProbeTargets(FACTS)).toMatchObject({ state: "ok", message: expect.stringContaining("unchanged") });
    await syncProbeTargets(FACTS);
    expect(kv).toHaveBeenCalledTimes(1);

    // Edits that do not reach the list (a title, notes, a LAN service) write nothing.
    patchTarget("a", { title: "Renamed", notes: "x" });
    addTarget({ key: "lan", url: "https://lan.example.com/", exposure: "lan" });
    await syncProbeTargets(FACTS);
    expect(kv).toHaveBeenCalledTimes(1);

    addTarget({ key: "c", url: "https://c.example.com/", exposure: "public-tunnel" });
    await syncProbeTargets(FACTS);
    expect(kv).toHaveBeenCalledTimes(2);
    expect(sent(1).value).toMatchObject({ version: 2, urls: [{ key: "a" }, { key: "c" }] });

    patchTarget("c", { expectedStatus: 403 });
    await syncProbeTargets(FACTS);
    expect(kv).toHaveBeenCalledTimes(3);
    expect(sent(2).value.version).toBe(3);
  });

  test("a changed home host is a change too", async () => {
    configure();
    await syncProbeTargets(FACTS);
    await syncProbeTargets({ ...FACTS, homeIp: "203.0.113.8", dns: [dns("home.example.com", "203.0.113.8", false)] });
    expect(kv).toHaveBeenCalledTimes(1);
    saveSecret("MONITOR_HOME_HOST", "ports.example.net");
    await syncProbeTargets(FACTS);
    expect(kv).toHaveBeenCalledTimes(2);
    expect(sent(1).value.homeHost).toBe("ports.example.net");
  });

  test("a failed write is reported and tried again on the next run", async () => {
    configure();
    kv.mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: "namespace not found" }] }, { status: 404 }));
    expect(await syncProbeTargets(FACTS)).toMatchObject({ state: "error", message: "Cloudflare KV 404: namespace not found" });
    expect((await syncProbeTargets(FACTS)).message).toBe("Wrote target list version 1");
    expect(kv).toHaveBeenCalledTimes(2);
  });

  test("a run that cannot tell the home host leaves the list alone, unless an override gives it", async () => {
    configure();
    expect(await syncProbeTargets({ dns: null, homeIp: HOME_IP })).toMatchObject({ state: "skipped" });
    expect(await syncProbeTargets({ dns: [], homeIp: null })).toMatchObject({ state: "skipped" });
    expect(kv).not.toHaveBeenCalled();
    saveSecret("MONITOR_HOME_HOST", "ports.example.net");
    expect((await syncProbeTargets({ dns: null, homeIp: null })).state).toBe("ok");
    expect(sent().value.homeHost).toBe("ports.example.net");
  });
});
