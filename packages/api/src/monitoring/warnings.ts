import { isWildcard } from "./exposure.js";
import type { DockerSpace, SourceName } from "./sources.js";

/** Conditions that are not an outage but deserve a look. Rules that need certificates join in a later phase. */
export interface Finding {
  /** Stable for the same condition, so a repeat run updates the warning instead of adding one. */
  key: string;
  kind: string;
  targetKey: string | null;
  text: string;
}

export interface WarningInput {
  /** Every port something listens on, with what owns it. */
  ports: { targetKey: string; port: number; bind: string; image: string | null; label: string }[];
  /** Hostnames the tunnel sends to Traefik that Traefik has no router for. */
  tunnelWithoutRouter: string[];
  /** Hostnames with a DNS record that points at the home IP. */
  directHostnames: string[];
  dockerSpace: DockerSpace[];
  containers: { name: string; targetKey: string | null; restartsLastHour: number; oomKilled: boolean }[];
}

export const DATABASE_IMAGE = /postgres|pgvector|redis|mysql|mariadb|mongo|clickhouse|minio/i;
const ADMIN_UI = /portainer|dashy|kuma|code-server/i;
const MAX_RESTARTS_PER_HOUR = 3;
const MAX_RECLAIMABLE_BYTES = 30e9;

const gb = (bytes: number) => `${Math.round(bytes / 1e9)} GB`;

/** Port 5433 on the mini kept its short warning key from before there were other hosts. The others are named, since their ports repeat. */
const portKey = (targetKey: string, port: number) => (targetKey.startsWith("mini:") ? String(port) : targetKey);

/** Warning kinds this module decides. Syncing resolves only these, so another phase's warnings stay open. */
export const DISCOVERY_WARNING_KINDS = [
  "database-open-lan", "admin-open-lan", "tunnel-without-router", "public-direct",
  "docker-reclaimable", "container-restarts", "container-oom",
] as const;

/** The sources a rule reads. A rule whose sources failed this run keeps its open warnings, so a blip does not clear them. */
export const WARNING_SOURCES: Record<(typeof DISCOVERY_WARNING_KINDS)[number], SourceName[]> = {
  "database-open-lan": ["docker", "listener"],
  "admin-open-lan": ["docker", "listener"],
  "tunnel-without-router": ["traefik", "cloudflare"],
  "public-direct": ["dns", "home-ip"],
  "docker-reclaimable": ["docker-space"],
  "container-restarts": ["docker"],
  "container-oom": ["docker"],
};

export function evaluateWarnings(input: WarningInput): Finding[] {
  const found: Finding[] = [];

  for (const { targetKey, port, bind, image, label } of input.ports) {
    if (!isWildcard(bind)) continue;
    const owner = `${image ?? ""} ${label}`;
    if (DATABASE_IMAGE.test(owner)) found.push({ key: `database-open-lan:${portKey(targetKey, port)}`, kind: "database-open-lan", targetKey, text: `${label} is a database or cache, and port ${port} is open to the LAN.` });
    if (ADMIN_UI.test(owner)) found.push({ key: `admin-open-lan:${portKey(targetKey, port)}`, kind: "admin-open-lan", targetKey, text: `${label} is an admin page, and port ${port} is open to the LAN.` });
  }

  for (const hostname of input.tunnelWithoutRouter) {
    found.push({ key: `tunnel-without-router:${hostname}`, kind: "tunnel-without-router", targetKey: hostname, text: `${hostname} is in the tunnel, but Traefik has no router for it. Requests get a 404.` });
  }

  for (const hostname of input.directHostnames) {
    found.push({ key: `public-direct:${hostname}`, kind: "public-direct", targetKey: hostname, text: `${hostname} has a DNS record on the home IP. The IP is visible to anyone.` });
  }

  const reclaimable = input.dockerSpace.reduce((sum, row) => sum + row.reclaimableBytes, 0);
  if (reclaimable > MAX_RECLAIMABLE_BYTES) {
    const parts = input.dockerSpace.filter((row) => row.reclaimableBytes >= 1e9).map((row) => `${row.type.toLowerCase()} ${gb(row.reclaimableBytes)}`);
    found.push({ key: "docker-reclaimable", kind: "docker-reclaimable", targetKey: null, text: `Docker can free ${gb(reclaimable)} (${parts.join(", ")}).` });
  }

  for (const { name, targetKey, restartsLastHour, oomKilled } of input.containers) {
    if (restartsLastHour > MAX_RESTARTS_PER_HOUR) found.push({ key: `container-restarts:${name}`, kind: "container-restarts", targetKey, text: `${name} restarted ${restartsLastHour} times in the last hour.` });
    if (oomKilled) found.push({ key: `container-oom:${name}`, kind: "container-oom", targetKey, text: `${name} was killed for running out of memory.` });
  }

  return found;
}

export interface RestartSample { ts: number; count: number }
const HOUR_MS = 3_600_000;

/** How many times a container restarted in the last hour, from its restart counter sampled at each discovery run. */
export function restartsLastHour(samples: readonly RestartSample[], now: number): number {
  const latest = samples.at(-1);
  if (!latest) return 0;
  // The count at the start of the hour is the last sample from before it, or the first one we have.
  const start = samples.filter((s) => now - s.ts > HOUR_MS).at(-1) ?? samples[0];
  return Math.max(0, latest.count - start.count);
}

// ── Hosts ───────────────────────────────────────────────────────────────

export const DISK_WARN_PCT = 85;
export const DISK_CRITICAL_PCT = 92;
export const MEMORY_WARN_PCT = 90;
export const MEMORY_CRITICAL_PCT = 97;
const MEMORY_WINDOW_MS = 10 * 60_000;

/**
 * Warning kinds decided from host metrics. The critical kinds are the ones phase 4 turns into incidents:
 * a warning has no severity column, and the kind says it.
 */
export const HOST_WARNING_KINDS = ["host-disk", "host-disk-critical", "host-memory", "host-memory-critical"] as const;
export const isCritical = (kind: string) => kind.endsWith("-critical");

export interface HostReading {
  host: string;
  title: string;
  diskPct: number | null;
  /** Memory use samples, oldest first. */
  memory: { ts: number; value: number }[];
}

/** True when every sample since 10 minutes ago, and the one that opened that window, is over the line. */
function highForWindow(samples: HostReading["memory"], line: number, now: number): boolean {
  // Samples are sorted, so the opener is the last one at or before the window start.
  const opener = samples.filter((s) => s.ts <= now - MEMORY_WINDOW_MS).length - 1;
  return opener >= 0 && samples.slice(opener).every((s) => s.value > line);
}

export function evaluateHostWarnings(hosts: HostReading[], now: number): Finding[] {
  const found: Finding[] = [];
  for (const { host, title, diskPct, memory } of hosts) {
    const targetKey = `host:${host}`;
    if (diskPct !== null && diskPct > DISK_WARN_PCT) {
      found.push({
        key: `host-disk:${host}`, kind: diskPct > DISK_CRITICAL_PCT ? "host-disk-critical" : "host-disk", targetKey,
        text: `${title} disk is ${Math.round(diskPct)}% full.`,
      });
    }
    const latest = memory.at(-1);
    if (latest && highForWindow(memory, MEMORY_WARN_PCT, now)) {
      found.push({
        key: `host-memory:${host}`, kind: latest.value > MEMORY_CRITICAL_PCT ? "host-memory-critical" : "host-memory", targetKey,
        text: `${title} memory is ${Math.round(latest.value)}% used, and has been over ${MEMORY_WARN_PCT}% for 10 minutes.`,
      });
    }
  }
  return found;
}
