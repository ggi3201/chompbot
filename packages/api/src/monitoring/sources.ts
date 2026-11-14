import { readFile, readlink } from "fs/promises";
import { Unavailable, run } from "./exec.js";
import { bindExposure } from "./exposure.js";

// Each source has a parser for its raw output, which tests feed with real output, and a reader that fetches it.
// A reader throws `Unavailable` when the source is not on this machine and any other error when it fails.

/** What a discovery run reads. The first five also name where a target was found. */
export type SourceName = "traefik" | "cloudflare" | "dns" | "docker" | "listener" | "tailscale" | "home-ip" | "docker-space" | "outside-probe";
export interface SourceStatus {
  source: SourceName;
  /** "skipped": not on this machine or not configured. "error": it should work and does not. */
  state: "ok" | "skipped" | "error";
  message: string | null;
  count: number;
}

const TRAEFIK_API = "http://127.0.0.1:8081/api/http";
const TRACE_URL = "https://cloudflare.com/cdn-cgi/trace";
const FETCH_TIMEOUT_MS = 8_000;

async function getText(url: string, what: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED") throw new Unavailable(`${what} is not running here`);
    throw new Error(err instanceof Error && err.name === "TimeoutError" ? `${what} did not answer` : `${what}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`${what} answered ${res.status}`);
  return res.text();
}

// ── Traefik ─────────────────────────────────────────────────────────────

export interface Backend { host: string; port: number }
export interface Route {
  hosts: string[];
  backend: Backend | null;
  /** Source ranges of the router's allow-list middleware, or null without one. */
  allowedRanges: string[] | null;
  /** The rule also matches on a path, so it covers only part of the hostname. */
  pathScoped: boolean;
}

interface TraefikRouter { rule?: string; service?: string; provider?: string; middlewares?: string[] }
interface TraefikService { name?: string; loadBalancer?: { servers?: { url?: string }[] } }
interface TraefikMiddleware { name?: string; ipAllowList?: { sourceRange?: string[] } }

function backendOf(service: TraefikService | undefined): Backend | null {
  const url = service?.loadBalancer?.servers?.[0]?.url;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80) };
  } catch {
    return null;
  }
}

export function parseRoutes(routers: TraefikRouter[], services: TraefikService[], middlewares: TraefikMiddleware[]): Route[] {
  return routers.flatMap((router): Route[] => {
    const hosts = [...(router.rule ?? "").matchAll(/Host\(`([^`]+)`\)/g)].map((match) => match[1].toLowerCase());
    if (!hosts.length || router.provider === "internal") return [];
    const serviceName = router.service?.includes("@") ? router.service : `${router.service}@${router.provider}`;
    const ranges = (router.middlewares ?? [])
      .map((name) => middlewares.find((m) => m.name === name)?.ipAllowList?.sourceRange)
      .find((range) => range);
    return [{
      hosts,
      backend: backendOf(services.find((s) => s.name === serviceName)),
      allowedRanges: ranges ?? null,
      pathScoped: /Path(Prefix|Regexp)?\(/.test(router.rule ?? ""),
    }];
  });
}

export async function readRoutes(): Promise<Route[]> {
  const [routers, services, middlewares] = await Promise.all(
    ["routers", "services", "middlewares"].map(async (name) => JSON.parse(await getText(`${TRAEFIK_API}/${name}`, "Traefik"))),
  );
  return parseRoutes(routers, services, middlewares);
}

// ── Docker ──────────────────────────────────────────────────────────────

interface PublishedPort { port: number; containerPort: number; bind: string }
export interface Container {
  name: string;
  image: string;
  /** The compose project, when the container belongs to one. */
  project: string | null;
  state: string;
  health: string | null;
  restarts: number;
  oomKilled: boolean;
  /** Its address on each Docker network. Traefik names the one on the proxy network, so every one has to match. */
  ips: string[];
  ports: PublishedPort[];
}

interface DockerInspect {
  Name: string;
  RestartCount: number;
  State: { Status: string; OOMKilled: boolean; Health?: { Status: string } };
  Config: { Image: string; Labels?: Record<string, string> };
  NetworkSettings: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks?: Record<string, { IPAddress: string }>;
  };
}

function publishedPorts(ports: NonNullable<DockerInspect["NetworkSettings"]["Ports"]>): PublishedPort[] {
  const byPort = new Map<number, PublishedPort>();
  for (const [key, bindings] of Object.entries(ports)) {
    if (!key.endsWith("/tcp")) continue;
    for (const { HostIp, HostPort } of bindings ?? []) {
      const port = Number(HostPort);
      // Docker lists an IPv4 and an IPv6 binding for the same port; one row is enough.
      if (!byPort.has(port)) byPort.set(port, { port, containerPort: Number(key.split("/")[0]), bind: HostIp || "0.0.0.0" });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export const parseContainers = (inspected: DockerInspect[]): Container[] =>
  inspected.map((c) => ({
    name: c.Name.replace(/^\//, ""),
    image: c.Config.Image.split("@")[0],
    project: c.Config.Labels?.["com.docker.compose.project"] ?? null,
    state: c.State.Status,
    health: c.State.Health?.Status ?? null,
    restarts: c.RestartCount,
    oomKilled: c.State.OOMKilled,
    ips: Object.values(c.NetworkSettings.Networks ?? {}).map((n) => n.IPAddress).filter(Boolean),
    ports: publishedPorts(c.NetworkSettings.Ports ?? {}),
  }));

export async function readContainers(): Promise<Container[]> {
  const ids = (await run("docker", ["ps", "-aq"])).split("\n").filter(Boolean);
  if (!ids.length) return [];
  // Inspect output includes each container's environment. Only the fields parsed above are kept.
  return parseContainers(JSON.parse(await run("docker", ["inspect", ...ids])));
}

/** One object of `docker ps --format '{{json .}}'`, as a host agent sends it. Only the keys read here are required. */
export interface DockerPsRow { Names: string; Image: string; State: string; Status?: string; Ports?: string; Labels?: string }

/** `0.0.0.0:5000->5000/tcp`, `:::5000->5000/tcp`, `[::]:80->80/tcp`, `127.0.0.1:8000-8001->8000-8001/tcp`. A port that is not published has no `->` and is skipped. */
const PS_PORT = /^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/tcp$/;

function psPorts(text: string): PublishedPort[] {
  const byPort = new Map<number, PublishedPort>();
  for (const part of text.split(",")) {
    const match = PS_PORT.exec(part.trim());
    if (!match) continue;
    const [, bind, from, to, containerFrom] = match;
    for (let offset = 0; offset <= Number(to ?? from) - Number(from); offset++) {
      const port = Number(from) + offset;
      if (!byPort.has(port)) byPort.set(port, { port, containerPort: Number(containerFrom) + offset, bind: bind.replace(/^\[|\]$/g, "") || "0.0.0.0" });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** "Up 3 days (healthy)", "Up 5 seconds (health: starting)", "Up 2 hours (unhealthy)". */
const psHealth = (status: string) => /\((?:health: )?(healthy|unhealthy|starting)\)/.exec(status)?.[1] ?? null;

/**
 * Containers of another host, from its `docker ps` rows. That output has no restart counts, OOM flags or
 * network addresses, so those stay empty: the mini cannot reach a container on another host by address anyway.
 */
export const parseDockerPs = (rows: DockerPsRow[]): Container[] =>
  rows.map((row) => ({
    name: row.Names.split(",")[0],
    image: row.Image.split("@")[0],
    project: /(?:^|,)com\.docker\.compose\.project=([^,]*)/.exec(row.Labels ?? "")?.[1] ?? null,
    state: row.State,
    health: psHealth(row.Status ?? ""),
    restarts: 0,
    oomKilled: false,
    ips: [],
    ports: psPorts(row.Ports ?? ""),
  }));

export interface DockerSpace { type: string; reclaimableBytes: number }

/** `docker system df` prints sizes in SI units ("21.34GB"). */
function toBytes(text: string): number {
  const match = /^([\d.]+)\s*([KMGT]?)B/i.exec(text.trim());
  if (!match) return 0;
  return Number(match[1]) * ({ "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[match[2].toUpperCase()] ?? 1);
}

export const parseDockerSpace = (output: string): DockerSpace[] =>
  output.split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line) as { Type: string; Reclaimable: string };
    // "120.2GB (81%)": the percentage is dropped.
    return { type: row.Type, reclaimableBytes: toBytes(row.Reclaimable.split(" ")[0]) };
  });

export const readDockerSpace = async () => parseDockerSpace(await run("docker", ["system", "df", "--format", "{{json .}}"]));

// ── Listening ports ─────────────────────────────────────────────────────

interface RawListener { bind: string; port: number; pid: number | null; comm: string | null }
export interface Listener extends RawListener { unit: string | null; title: string }

const SS_LINE = /^LISTEN\s+\d+\s+\d+\s+(?:\[([^\]]+)\]|([^:\s%]+))(?:%\S+?)?:(\d+)\s+\S+\s*(.*)$/;

/** Parses `ss -tlnp`. Forms seen: `0.0.0.0:80`, `127.0.0.53%lo:53`, `[::]:80`, `*:4999`, `[fd7a::1]%tailscale0:8443`. */
export function parseSs(output: string): RawListener[] {
  return output.split("\n").flatMap((line): RawListener[] => {
    const match = SS_LINE.exec(line);
    if (!match) return [];
    const [, v6, v4, port, owner] = match;
    const process = /users:\(\("([^"]*)",pid=(\d+)/.exec(owner);
    return [{ bind: v6 ?? (v4 === "*" ? "0.0.0.0" : v4), port: Number(port), pid: process ? Number(process[2]) : null, comm: process?.[1] ?? null }];
  });
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (macOS, which has no `ss`): p<pid>, c<command>, then n<bind:port> per socket. */
export function parseLsof(output: string): RawListener[] {
  let pid: number | null = null;
  let comm: string | null = null;
  return output.split("\n").flatMap((line): RawListener[] => {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) comm = line.slice(1);
    const match = line.startsWith("n") ? /^n\[?([^\]]*?)\]?:(\d+)$/.exec(line) : null;
    if (!match) return [];
    return [{ bind: match[1] === "*" ? "0.0.0.0" : match[1], port: Number(match[2]), pid, comm }];
  });
}

/** One row per port and reach: the IPv4 and IPv6 listeners of one socket are the same listener. */
export function dedupeListeners<T extends { port: number; bind: string }>(listeners: T[], tailnetIps: readonly string[] = []): T[] {
  const seen = new Set<string>();
  return listeners.filter((l) => {
    const key = `${l.port}|${bindExposure(l.bind, tailnetIps)}`;
    return !seen.has(key) && seen.add(key);
  });
}

/** The service unit of a process: the last `.service` in its cgroup path, other than the user manager. */
export const unitFromCgroup = (cgroup: string): string | null =>
  cgroup.split("\n")[0].split("/").reverse().find((part) => part.endsWith(".service") && !part.startsWith("user@"))?.replace(/\\x2d/g, "-") ?? null;

/**
 * A name for a listener. `ss` cuts process names to 15 characters, so every Next.js app is "next-server (v1".
 * The service unit comes first, then the name of the directory the process runs in.
 */
export function listenerTitle(listener: RawListener, unit: string | null, cwd: string | null): string {
  if (unit) return unit.replace(/\.service$/, "");
  if (cwd) {
    const parts = cwd.split("/").filter(Boolean);
    const releases = parts.lastIndexOf("releases");
    // Deploy layouts like <app>/releases/<timestamp>: the app is the directory above.
    const base = releases > 0 ? parts[releases - 1] : parts[parts.length - 1];
    if (base && base !== "proc") return base;
  }
  const comm = listener.comm;
  if (comm && !comm.includes("(") && comm.length < 15) return comm;
  return comm?.split(" ")[0] || `port ${listener.port}`;
}

/** A listener a host agent saw. The agent sends no pid, so the title comes from the process name alone. */
export function listenerFromReport(entry: { bind: string; port: number; process?: string }): Listener {
  const raw: RawListener = { bind: entry.bind, port: entry.port, pid: null, comm: entry.process ?? null };
  return { ...raw, unit: null, title: listenerTitle(raw, null, null) };
}

const readOrNull = async <T>(read: () => Promise<T>): Promise<T | null> => read().catch(() => null);

export async function readListeners(): Promise<Listener[]> {
  const raw = process.platform === "darwin"
    ? parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]))
    : parseSs(await run("ss", ["-tlnp"]));
  return Promise.all(raw.map(async (listener) => {
    const [cgroup, cwd] = listener.pid === null ? [null, null]
      : await Promise.all([readOrNull(() => readFile(`/proc/${listener.pid}/cgroup`, "utf8")), readOrNull(() => readlink(`/proc/${listener.pid}/cwd`))]);
    const unit = cgroup ? unitFromCgroup(cgroup) : null;
    return { ...listener, unit, title: listenerTitle(listener, unit, cwd) };
  }));
}

// ── Tailscale and the home IP ───────────────────────────────────────────

export const parseTailnetIps = (status: { TailscaleIPs?: string[]; Self?: { TailscaleIPs?: string[] } }): string[] =>
  status.Self?.TailscaleIPs ?? status.TailscaleIPs ?? [];

export const readTailnetIps = async () => parseTailnetIps(JSON.parse(await run("tailscale", ["status", "--json"])));

export const parseHomeIp = (trace: string): string | null => /^ip=(\S+)$/m.exec(trace)?.[1] ?? null;

export const readHomeIp = async () => {
  const ip = parseHomeIp(await getText(TRACE_URL, "cloudflare.com"));
  if (!ip) throw new Error("cloudflare.com did not say the IP");
  return ip;
};
