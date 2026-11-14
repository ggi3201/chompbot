import { createHash } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { monitorTargets, settings } from "../db/schema.js";
import { getSecret } from "../lib/secrets.js";
import { API, credentials, type DnsRecord } from "./cloudflare.js";
import { Unavailable } from "./exec.js";
import type { SourceStatus } from "./sources.js";

// The target list the outside probe reads from Workers KV. Format: packages/outside-probe/CONTRACT.md.

/** Ports the Worker tries on the home host every 15 minutes. Any that answers is a warning. */
export const PROBE_PORTS = [22, 80, 443, 3001, 5433, 5434, 5435, 5632, 6379, 8000, 9000, 9443];
const STATE_SETTING = "monitor:probe-targets";
const FETCH_TIMEOUT_MS = 10_000;

export interface ProbeUrl { key: string; url: string; expectedStatus?: number }
export interface ProbeList { urls: ProbeUrl[]; ports: number[]; homeHost: string }

const isWebUrl = (url: string | null): url is string => {
  try {
    return url !== null && ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** Tracked http targets that the internet can reach, by key. */
export function publicUrls(): ProbeUrl[] {
  return db.select().from(monitorTargets).where(and(eq(monitorTargets.tracked, true), isNull(monitorTargets.retiredAt))).all()
    .filter((t) => t.kind === "http" && (t.exposure === "public-tunnel" || t.exposure === "public-direct") && isWebUrl(t.url))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t) => ({ key: t.key, url: t.url!, ...(t.expectedStatus !== null && { expectedStatus: t.expectedStatus }) }));
}

/**
 * Where the Worker opens its port checks. The Worker cannot open raw TCP to a proxied host, so this is an
 * override, a DNS-only record that points at the home IP, or the home IP itself.
 */
export function pickHomeHost(input: { override: string | null; dns: readonly DnsRecord[]; homeIp: string }): string {
  const override = input.override?.trim();
  if (override) return override;
  const names = input.dns
    .filter((r) => (r.type === "A" || r.type === "AAAA") && r.content === input.homeIp && !r.proxied && !r.name.includes("*"))
    .map((r) => r.name).sort();
  return names[0] ?? input.homeIp;
}

export const hashOf = (list: ProbeList) => createHash("sha256").update(JSON.stringify(list)).digest("hex");

interface WrittenState { hash: string; version: number }

const readState = (): WrittenState | null => {
  const row = db.select().from(settings).where(eq(settings.key, STATE_SETTING)).get();
  return row ? (JSON.parse(row.value) as WrittenState) : null;
};

const saveState = (state: WrittenState) => {
  const value = JSON.stringify(state);
  db.insert(settings).values({ key: STATE_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
};

async function putTargets(namespace: string, value: string): Promise<void> {
  const { token, account } = await credentials();
  const res = await fetch(`${API}/accounts/${account}/storage/kv/namespaces/${namespace}/values/targets`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: value,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { message: string }[] } | null;
  if (!res.ok || !body?.success) throw new Error(`Cloudflare KV ${res.status}: ${body?.errors?.[0]?.message ?? "no answer"}`);
}

interface HomeFacts {
  /** DNS records of this run, or null when the DNS source did not answer. */
  dns: readonly DnsRecord[] | null;
  homeIp: string | null;
}

async function writeIfChanged({ dns, homeIp }: HomeFacts): Promise<{ state: SourceStatus["state"]; message: string; count: number }> {
  const token = getSecret("CLOUDFLARE_API_TOKEN");
  const namespace = getSecret("CLOUDFLARE_KV_NAMESPACE_ID");
  if (!token || !namespace) {
    // The account id is not listed: credentials() finds it from the token.
    const missing = [token ? null : "CLOUDFLARE_API_TOKEN", namespace ? null : "CLOUDFLARE_KV_NAMESPACE_ID"].filter(Boolean);
    throw new Unavailable(`Not configured: deploy the Worker, then set ${missing.join(" and ")} in Settings`);
  }
  const override = getSecret("MONITOR_HOME_HOST");
  // A run that could not read DNS or the home IP must not swap the host: the list would change back and forth.
  if (!override?.trim() && (dns === null || homeIp === null)) {
    return { state: "skipped", message: "Home host unknown this run: DNS or the home IP did not answer", count: 0 };
  }
  const urls = publicUrls();
  const list: ProbeList = { urls, ports: PROBE_PORTS, homeHost: pickHomeHost({ override: override ?? null, dns: dns ?? [], homeIp: homeIp ?? "" }) };
  const hash = hashOf(list);
  const written = readState();
  if (written?.hash === hash) return { state: "ok", message: `Target list unchanged (version ${written.version})`, count: urls.length };
  const version = (written?.version ?? 0) + 1;
  await putTargets(namespace, JSON.stringify({ version, ...list }));
  // Saved only after Cloudflare accepted the write, so a failed write is tried again on the next run.
  saveState({ hash, version });
  return { state: "ok", message: `Wrote target list version ${version}`, count: urls.length };
}

/** After a discovery run: writes the probe's target list to KV when it changed. Never throws; the answer says how it went. */
export async function syncProbeTargets(facts: HomeFacts): Promise<SourceStatus> {
  try {
    return { source: "outside-probe", ...(await writeIfChanged(facts)) };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
    return { source: "outside-probe", state: err instanceof Unavailable ? "skipped" : "error", message, count: 0 };
  }
}
