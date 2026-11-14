import { readFileSync } from "fs";
import { parseDnsRecords, parseIngress } from "../../src/monitoring/cloudflare.js";
import type { Snapshot } from "../../src/monitoring/discover.js";
import {
  dedupeListeners, listenerTitle, parseContainers, parseDockerSpace, parseHomeIp, parseRoutes, parseSs, parseTailnetIps, unitFromCgroup,
} from "../../src/monitoring/sources.js";

export const fixture = (name: string) => readFileSync(new URL(`../fixtures/monitoring/${name}`, import.meta.url), "utf8");
export const json = (name: string) => JSON.parse(fixture(name));

/** The mini's cgroup and working directory for each pid in the `ss` fixture, read the same day. */
const processes: Record<string, { cgroup: string; cwd: string | null }> = json("proc-processes.json");

/** A snapshot of the mini on 2026-11-08, parsed from sanitized captured output: the same path a real run takes after the readers. */
export function miniSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const tailnetIps = parseTailnetIps(json("tailscale-status.json"));
  const listeners = dedupeListeners(parseSs(fixture("ss-tlnp.txt")).map((raw) => {
    const process = raw.pid === null ? undefined : processes[raw.pid];
    const unit = process?.cgroup ? unitFromCgroup(process.cgroup) : null;
    return { ...raw, unit, title: listenerTitle(raw, unit, process?.cwd ?? null) };
  }), tailnetIps);
  return {
    routes: parseRoutes(json("traefik-routers.json"), json("traefik-services.json"), json("traefik-middlewares.json")),
    tunnel: parseIngress(json("cloudflare-tunnel.json").result),
    dns: parseDnsRecords([...json("cloudflare-dns-home.json").result, ...json("cloudflare-dns-apps.json").result]),
    homeIp: parseHomeIp(fixture("cdn-cgi-trace.txt")),
    containers: parseContainers(json("docker-inspect.json")),
    listeners,
    dockerSpace: parseDockerSpace(fixture("docker-system-df.txt")),
    tailnetIps,
    localAddresses: ["10.0.2.248", "127.0.0.1", "172.17.0.1", "172.18.0.1"],
    statuses: [],
    ...overrides,
  };
}
