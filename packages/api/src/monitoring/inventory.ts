import { bindExposure, EXPOSURE_LABELS, EXPOSURE_LEVELS, type Exposure } from "./exposure.js";
import type { OutsideRow } from "./outside.js";
import type { DiscoveryRun } from "./run.js";
import type { TargetRow, TargetState, WarningRow } from "./views.js";

interface PortRow {
  host: string;
  port: number;
  bind: string;
  exposure: Exposure;
  /** The container that publishes the port, else the service unit or program that listens. */
  owner: string;
  container: string | null;
  image: string | null;
  unit: string | null;
  /** The target that checks this port, when there is one. */
  targetKey: string | null;
  targetTitle: string | null;
}

type HostPorts = Pick<DiscoveryRun, "listeners" | "containers"> & { host: string };

/** Every listening port of the last run, on the mini and on each host that reported. A port with no visible target is one nobody claims. */
export function buildPorts(run: DiscoveryRun | null, rows: TargetRow[]): PortRow[] {
  if (!run) return [];
  const hosts: HostPorts[] = [{ host: "mini", listeners: run.listeners, containers: run.containers }, ...run.hosts];
  return hosts.flatMap(({ host, listeners, containers }) => {
    const onHost = rows.filter((row) => !row.retired && !row.hidden && row.host === host && row.bind !== null);
    return listeners.map((l): PortRow => {
      const publisher = containers.find((c) => c.ports.some((p) => p.port === l.port));
      // A hostname that Traefik sends here speaks for the port over the plain port target, which discovery hides.
      const target = onHost.filter((row) => row.port === l.port).sort((a, b) => Number(b.tracked) - Number(a.tracked))[0];
      return {
        host,
        port: l.port,
        bind: l.bind,
        exposure: bindExposure(l.bind, run.tailnetIps),
        owner: publisher?.name ?? l.title,
        container: publisher?.name ?? null,
        image: publisher?.image ?? null,
        unit: l.unit,
        targetKey: target?.key ?? null,
        targetTitle: target?.title ?? null,
      };
    }).sort((a, b) => a.port - b.port);
  });
}

interface ExposureLevel {
  level: Exposure;
  label: string;
  targets: { key: string; title: string; state: TargetState; tracked: boolean; port: number | null; bind: string | null; container: string | null; outside: OutsideRow | null }[];
  warnings: WarningRow[];
}

/** Visible targets by how far they reach, widest first. Each level carries the warnings of its targets. */
export function buildExposure(rows: TargetRow[], warnings: WarningRow[]): { levels: ExposureLevel[]; other: WarningRow[] } {
  const placed = rows.filter((row) => !row.retired && row.exposure !== null);
  const visible = placed.filter((row) => !row.hidden);
  // A warning about a port that discovery hid (portainer's second port) still belongs to that port's level.
  const levelOf = new Map(placed.map((row) => [row.key, row.exposure]));
  return {
    levels: EXPOSURE_LEVELS.map((level) => {
      const targets = visible.filter((row) => row.exposure === level);
      return {
        level,
        label: EXPOSURE_LABELS[level],
        targets: targets.map((row) => ({ key: row.key, title: row.title, state: row.state, tracked: row.tracked, port: row.port, bind: row.bind, container: row.container, outside: row.outside })),
        warnings: warnings.filter((w) => w.targetKey !== null && levelOf.get(w.targetKey) === level),
      };
    }),
    other: warnings.filter((w) => w.targetKey === null || !levelOf.has(w.targetKey)),
  };
}
