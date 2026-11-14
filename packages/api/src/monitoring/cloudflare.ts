import { getSecret } from "../lib/secrets.js";
import { Unavailable } from "./exec.js";

export const API = "https://api.cloudflare.com/client/v4";
const FETCH_TIMEOUT_MS = 10_000;

export interface TunnelRule {
  hostname: string;
  /** Set when the rule covers only a path of the hostname. */
  path: string | null;
  /** Where cloudflared sends the request: `https://localhost:443`, `http://localhost:3002`, `http_status:404`. */
  service: string;
}
export interface DnsRecord { name: string; type: string; content: string; proxied: boolean }

interface Tunnel { id: string; config_src?: string }
interface TunnelConfig { config?: { ingress?: { hostname?: string; path?: string; service: string }[] } | null }

/** Ingress rules that name a hostname. The catch-all rule at the end has none. */
export const parseIngress = ({ config }: TunnelConfig): TunnelRule[] =>
  (config?.ingress ?? []).flatMap((rule) => (rule.hostname ? [{ hostname: rule.hostname.toLowerCase(), path: rule.path ?? null, service: rule.service }] : []));

export const parseDnsRecords = (records: DnsRecord[]): DnsRecord[] =>
  records.filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME").map(({ name, type, content, proxied }) => ({ name: name.toLowerCase(), type, content, proxied }));

// The account a token belongs to does not change, so it is looked up once per token, not on every run.
let lookedUp: { token: string; account: string } | null = null;

/** The account id comes from the setting, or else from the token itself when it sees exactly one account. */
async function accountFor(token: string): Promise<string> {
  const set = getSecret("CLOUDFLARE_ACCOUNT_ID");
  if (set) return set;
  if (lookedUp?.token === token) return lookedUp.account;
  const accounts = await get<{ id: string }[]>(token, "/accounts");
  if (accounts.length !== 1) {
    throw new Error(`The token sees ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID in Settings.`);
  }
  lookedUp = { token, account: accounts[0].id };
  return lookedUp.account;
}

export async function credentials(): Promise<{ token: string; account: string }> {
  const token = getSecret("CLOUDFLARE_API_TOKEN");
  if (!token) throw new Unavailable("Not configured");
  return { token, account: await accountFor(token) };
}

async function get<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !body?.success) throw new Error(`Cloudflare ${res.status}: ${body?.errors?.[0]?.message ?? "no answer"}`);
  return body.result as T;
}

/** Ingress of every tunnel that is configured in Cloudflare. A tunnel with a local config file has none to read. */
export async function readTunnelRules(): Promise<TunnelRule[]> {
  const { token, account } = await credentials();
  const tunnels = await get<Tunnel[]>(token, `/accounts/${account}/cfd_tunnel?is_deleted=false`);
  const configs = await Promise.all(tunnels.filter((t) => t.config_src === "cloudflare")
    .map((t) => get<TunnelConfig>(token, `/accounts/${account}/cfd_tunnel/${t.id}/configurations`)));
  return configs.flatMap(parseIngress);
}

export async function readDnsRecords(): Promise<DnsRecord[]> {
  const { token, account } = await credentials();
  const zones = await get<{ id: string }[]>(token, `/zones?account.id=${account}&per_page=50`);
  const records = await Promise.all(zones.map((zone) => get<DnsRecord[]>(token, `/zones/${zone.id}/dns_records?per_page=1000`)));
  return parseDnsRecords(records.flat());
}
