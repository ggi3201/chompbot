import { networkInterfaces } from "os";
import type { ContainerInfo } from "../db/schema.js";
import { readDnsRecords, readTunnelRules, type DnsRecord, type TunnelRule } from "./cloudflare.js";
import { Unavailable } from "./exec.js";
import { bindExposure, classify, isLoopback, isWildcard, widest, type Exposure } from "./exposure.js";
import {
  dedupeListeners, readContainers, readDockerSpace, readHomeIp, readListeners, readRoutes, readTailnetIps,
  type Backend, type Container, type DockerSpace, type Listener, type Route, type SourceName, type SourceStatus,
} from "./sources.js";
import { DATABASE_IMAGE, evaluateWarnings, type Finding } from "./warnings.js";

export const DISCOVERY_SOURCES = ["traefik", "cloudflare", "dns", "docker", "listener"] as const satisfies readonly SourceName[];
type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];
/** Where a target on another host was found: that host's report. */
export type AgentSource = `agent:${string}`;
export const agentSource = (host: string): AgentSource => `agent:${host}`;

/** The machine Chomp runs on. Every other host is seen through its agent's reports. */
export const MINI = "mini";
export const hostDependency = (host: string) => `host:${host}`;
export const HOST_DEPENDENCY = hostDependency(MINI);
const TRAEFIK_DEPENDENCY = "infra:traefik";
const TUNNEL_DEPENDENCY = "infra:tunnel";
/** Protocols other than HTTP, which get a TCP check. */
const RAW_PORTS = new Set([22, 25, 53, 110, 143, 445, 1433, 3306, 5432, 6379, 11211, 27017]);
/** Linux hands these out to programs that did not ask for a port. A loopback listener up here is a tool, not a service. */
const EPHEMERAL_PORT_START = 32_768;

/** What one discovery run saw. */
export interface Snapshot {
  routes: Route[];
  tunnel: TunnelRule[];
  dns: DnsRecord[];
  homeIp: string | null;
  containers: Container[];
  listeners: Listener[];
  dockerSpace: DockerSpace[];
  tailnetIps: string[];
  /** Addresses of this machine's own network interfaces. */
  localAddresses: string[];
  statuses: SourceStatus[];
}

/** A target as discovery would create it. Merging decides what of this reaches the database. */
export interface Found {
  key: string;
  title: string;
  kind: "http" | "tcp" | "container";
  url: string | null;
  host: string;
  port: number | null;
  bindAddress: string | null;
  container: string | null;
  image: string | null;
  systemdUnit: string | null;
  project: string | null;
  sources: (DiscoverySource | AgentSource)[];
  dependsOn: string[];
  exposure: Exposure;
  tracked: boolean;
  hidden: boolean;
  containerInfo: ContainerInfo | null;
}

// ── Collecting ──────────────────────────────────────────────────────────

const SOURCE_ORDER: SourceName[] = ["traefik", "cloudflare", "dns", "docker", "listener", "tailscale", "home-ip", "docker-space"];
const sizeOf = (value: unknown) => (Array.isArray(value) ? value.length : value ? 1 : 0);

function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? []).map((a) => a.address));
}

/** Reads every source at once. A source that is missing or fails gives its fallback and a status, and the others carry on. */
export async function collectSnapshot(): Promise<Snapshot> {
  const statuses: SourceStatus[] = [];
  const read = async <T>(source: SourceName, reader: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const value = await reader();
      statuses.push({ source, state: "ok", message: null, count: sizeOf(value) });
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      statuses.push({ source, state: err instanceof Unavailable ? "skipped" : "error", message, count: 0 });
      return fallback;
    }
  };
  const [routes, tunnel, dns, containers, rawListeners, dockerSpace, tailnetIps, homeIp] = await Promise.all([
    read("traefik", readRoutes, []),
    read("cloudflare", readTunnelRules, []),
    read("dns", readDnsRecords, []),
    read("docker", readContainers, []),
    read("listener", readListeners, []),
    read("docker-space", readDockerSpace, []),
    read("tailscale", readTailnetIps, []),
    read<string | null>("home-ip", readHomeIp, null),
  ]);
  return {
    routes, tunnel, dns, homeIp, containers, dockerSpace, tailnetIps,
    listeners: dedupeListeners(rawListeners, tailnetIps),
    localAddresses: localAddresses(),
    statuses: statuses.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)),
  };
}

// ── Planning ────────────────────────────────────────────────────────────

/** Where a tunnel rule sends requests, when it sends them to a port. */
const backendOfService = (service: string): Backend | null => {
  const match = /^https?:\/\/([^/:]+):(\d+)/.exec(service);
  return match ? { host: match[1], port: Number(match[2]) } : null;
};

/** The domain's own label (alt.example.com and example.com are "example"), so a domain's sites group together. */
const projectFromHostname = (hostname: string) => hostname.split(".").at(-2) ?? hostname;

const isRaw = (image: string | null, ...ports: number[]) => (image !== null && DATABASE_IMAGE.test(image)) || ports.some((p) => RAW_PORTS.has(p));

/** What a container tells about the target it backs. */
export function containerFacts(c: Container, tailnetIps: readonly string[]) {
  return {
    container: c.name,
    image: c.image,
    containerInfo: { state: c.state, health: c.health, restarts: c.restarts, oomKilled: c.oomKilled, ip: c.ips[0] ?? null },
    exposure: widest(c.ports.length ? c.ports.map((p) => bindExposure(p.bind, tailnetIps)) : ["local"]),
  };
}

interface Plan { found: Found[]; warnings: Finding[] }

/** The host a plan is for, and the address the mini reaches it at. */
export interface PlanHost { name: string; address: string }
const MINI_HOST: PlanHost = { name: MINI, address: "127.0.0.1" };

/**
 * Merges what the sources saw into one list of targets, hides the noise, and finds the warnings.
 * For a host other than the mini, the snapshot holds only what its agent reported. Its loopback ports are left out,
 * since the mini cannot reach them to check.
 */
/** An IPv6 address needs brackets in a URL, or its colons read as the port. */
export const httpUrl = (address: string, port: number) => `http://${address.includes(":") ? `[${address}]` : address}:${port}`;

export function planTargets(s: Snapshot, restartsByContainer: ReadonlyMap<string, number> = new Map(), where: PlanHost = MINI_HOST): Plan {
  const HOST = where.name;
  const isRemote = HOST !== MINI;
  const checkAddress = (bind: string) => (isWildcard(bind) ? where.address : bind);
  const reachable = (bind: string) => !isRemote || !isLoopback(bind);
  const sourceOf = (own: DiscoverySource) => (isRemote ? agentSource(HOST) : own);
  const dependency = hostDependency(HOST);
  const containerByIp = new Map(s.containers.flatMap((c) => c.ips.map((ip) => [ip, c] as const)));
  const publisherOf = new Map(s.containers.flatMap((c) => c.ports.map((p) => [p.port, { container: c, port: p }] as const)));
  const listenerOf = (port: number) => s.listeners.find((l) => l.port === port);
  const isLocalAddress = (host: string) => host === "localhost" || isLoopback(host) || s.localAddresses.includes(host) || s.tailnetIps.includes(host);

  const routeHosts = new Set(s.routes.flatMap((r) => r.hosts));
  const sendsToTraefik = (target: Backend | null) => target !== null && isLocalAddress(target.host) && target.port === 443;
  const directHosts = new Set(s.dns.filter((r) => (r.type === "A" || r.type === "AAAA") && r.content === s.homeIp).map((r) => r.name));
  const hostnames = [...new Set([...routeHosts, ...s.tunnel.map((t) => t.hostname), ...directHosts])].filter((h) => !h.includes("*")).sort();

  const found: Found[] = [];
  const claimedContainers = new Set<string>();
  const backendPorts = new Set<number>();

  for (const hostname of hostnames) {
    const routes = s.routes.filter((r) => r.hosts.includes(hostname));
    const route = routes.find((r) => !r.pathScoped) ?? routes[0] ?? null;
    const rules = s.tunnel.filter((t) => t.hostname === hostname);
    const rule = rules.find((t) => !t.path) ?? rules[0] ?? null;
    const tunnelTarget = rule ? backendOfService(rule.service) : null;
    const viaTraefik = sendsToTraefik(tunnelTarget);
    const backend = route?.backend ?? (viaTraefik ? null : tunnelTarget);

    const container = backend ? containerByIp.get(backend.host) : undefined;
    const hostPort = backend && !container && isLocalAddress(backend.host) ? backend.port : null;
    const listener = hostPort === null ? undefined : listenerOf(hostPort);
    const publisher = hostPort === null ? undefined : publisherOf.get(hostPort);
    const owner = container ?? publisher?.container;
    const remote = backend && !container && hostPort === null ? backend.host : null;
    if (hostPort !== null) backendPorts.add(hostPort);
    if (owner) claimedContainers.add(owner.name);

    const hostBind = listener?.bind ?? publisher?.port.bind ?? null;
    const binds = container ? (container.ports.length ? container.ports.map((p) => p.bind) : [null]) : hostBind ? [hostBind] : [];
    const direct = directHosts.has(hostname);
    found.push({
      key: hostname,
      title: hostname,
      kind: "http",
      url: `https://${hostname}`,
      host: remote ?? HOST,
      port: backend?.port ?? null,
      bindAddress: hostBind,
      container: owner?.name ?? null,
      image: owner?.image ?? null,
      systemdUnit: listener?.unit ?? null,
      project: owner?.project ?? projectFromHostname(hostname),
      sources: [route && "traefik", rule && "cloudflare", direct && "dns"].filter((x): x is DiscoverySource => !!x),
      dependsOn: [dependency, ...(route || viaTraefik ? [TRAEFIK_DEPENDENCY] : []), ...(rule ? [TUNNEL_DEPENDENCY] : [])],
      exposure: classify({ tunnel: !!rule, direct, route: route && { allowedRanges: route.allowedRanges }, binds }, s.tailnetIps),
      tracked: !!(route || rule),
      hidden: false,
      containerInfo: owner ? containerFacts(owner, s.tailnetIps).containerInfo : null,
    });
  }

  for (const c of s.containers.filter((c) => c.state === "running" || c.state === "restarting")) {
    const facts = containerFacts(c, s.tailnetIps);
    const routed = claimedContainers.has(c.name);
    const ports = c.ports.filter((p) => reachable(p.bind));
    for (const [index, p] of ports.entries()) {
      const raw = isRaw(c.image, p.port, p.containerPort);
      found.push({
        key: `${HOST}:${p.port}`,
        title: c.name,
        kind: raw ? "tcp" : "http",
        url: raw ? null : httpUrl(checkAddress(p.bind), p.port),
        host: HOST,
        port: p.port,
        bindAddress: p.bind,
        container: c.name,
        image: c.image,
        systemdUnit: null,
        project: c.project,
        sources: [sourceOf("docker")],
        dependsOn: [dependency],
        exposure: bindExposure(p.bind, s.tailnetIps),
        tracked: false,
        // One row per container, unless something already reaches it by name.
        hidden: index > 0 || routed || backendPorts.has(p.port),
        containerInfo: facts.containerInfo,
      });
    }
    if (!ports.length && !routed) {
      found.push({
        key: `${isRemote ? `${HOST}:` : ""}container:${c.name}`, title: c.name, kind: "container", url: null, host: HOST, port: null, bindAddress: null,
        container: c.name, image: c.image, systemdUnit: null, project: c.project, sources: [sourceOf("docker")], dependsOn: [dependency],
        exposure: "local", tracked: false, hidden: false, containerInfo: facts.containerInfo,
      });
    }
  }

  for (const l of s.listeners.filter((l) => !publisherOf.has(l.port) && reachable(l.bind))) {
    const raw = isRaw(null, l.port);
    found.push({
      key: `${HOST}:${l.port}`,
      title: l.title,
      kind: raw ? "tcp" : "http",
      url: raw ? null : httpUrl(checkAddress(l.bind), l.port),
      host: HOST,
      port: l.port,
      bindAddress: l.bind,
      container: null,
      image: null,
      systemdUnit: l.unit,
      project: null,
      sources: [sourceOf("listener")],
      dependsOn: [dependency],
      exposure: bindExposure(l.bind, s.tailnetIps),
      tracked: false,
      hidden: backendPorts.has(l.port) || l.title === `port ${l.port}` || (isLoopback(l.bind) && l.port >= EPHEMERAL_PORT_START),
      containerInfo: null,
    });
  }

  const targetOfContainer = (name: string) => found.find((f) => f.container === name)?.key ?? null;
  return {
    found,
    warnings: evaluateWarnings({
      ports: [
        ...s.containers.flatMap((c) => c.ports.map((p) => ({ targetKey: `${HOST}:${p.port}`, port: p.port, bind: p.bind, image: c.image, label: c.name }))),
        ...s.listeners.filter((l) => !publisherOf.has(l.port)).map((l) => ({ targetKey: `${HOST}:${l.port}`, port: l.port, bind: l.bind, image: null, label: l.title })),
      ],
      tunnelWithoutRouter: s.tunnel
        .filter((t) => !t.hostname.includes("*") && !routeHosts.has(t.hostname) && sendsToTraefik(backendOfService(t.service)))
        .map((t) => t.hostname),
      directHostnames: [...directHosts].filter((h) => hostnames.includes(h)),
      dockerSpace: s.dockerSpace,
      containers: s.containers.filter((c) => c.state !== "exited").map((c) => ({
        name: c.name, targetKey: targetOfContainer(c.name), restartsLastHour: restartsByContainer.get(c.name) ?? 0, oomKilled: c.oomKilled,
      })),
    }),
  };
}
