import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { monitorTargets, monitorWarnings } from "../db/schema.js";
import { containerFacts, DISCOVERY_SOURCES, HOST_DEPENDENCY, type Found } from "./discover.js";
import { closeIncidentOf } from "./incidents.js";
import type { Target } from "./schedule.js";
import type { Container } from "./sources.js";
import { createTarget, hostnameOf, isKuma } from "./store.js";
import type { Finding } from "./warnings.js";

const DISCOVERY_SOURCE_SET: ReadonlySet<string> = new Set(DISCOVERY_SOURCES);

/** Runs in a row that must miss a discovered target before it is retired. */
export const MISSED_RUNS_TO_RETIRE = 3;

const isDiscoverySource = (source: string) => DISCOVERY_SOURCE_SET.has(source) || source.startsWith("agent:");

/** Created by discovery. Targets from Kuma or by hand are never retired and keep their own title, URL and tracking. */
const isDiscovered = (t: Target) => !isKuma(t) && t.sources.some(isDiscoverySource);

const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];

export interface MergeInput {
  found: Found[];
  containers: Container[];
  tailnetIps: string[];
  /** Sources that answered this run. A target is only missed when every source that found it answered. */
  okSources: ReadonlySet<string>;
  now: number;
}
export interface MergeSummary { created: number; updated: number; retired: number; restored: number }

type Update = Partial<typeof monitorTargets.$inferInsert>;

/** What a found target changes on one that exists. The fields a person edited stay as they are. */
function updateFor(target: Target, f: Found, stamp: string): Update {
  const owned = isDiscovered(target);
  const edited = new Set(target.userFields);
  const mayDefault = (field: string) => owned && !edited.has(field);
  return {
    host: f.host, port: f.port, bindAddress: f.bindAddress, container: f.container, image: f.image, systemdUnit: f.systemdUnit,
    exposure: f.exposure, dependsOn: f.dependsOn, containerInfo: f.containerInfo,
    sources: union(target.sources, f.sources),
    lastSeen: stamp, missedRuns: 0, retiredAt: null,
    ...(owned && { kind: f.kind, url: f.url }),
    ...(mayDefault("title") && { title: f.title }),
    ...(mayDefault("tracked") && { tracked: f.tracked }),
    ...(mayDefault("hidden") && { hidden: f.hidden }),
    ...((owned || target.project === null) && !edited.has("project") && f.project !== null && { project: f.project }),
  };
}

/** A Kuma monitor of the same hostname is the same service: the found target joins it instead of making a twin. */
const kumaTwin = (targets: Target[], f: Found) =>
  f.url?.startsWith("https://") ? targets.find((t) => isKuma(t) && t.kind === "http" && hostnameOf(t.url) === f.key) : undefined;

/**
 * Brings the targets in line with what discovery found: adds new ones, refreshes the facts of known ones,
 * brings back retired ones that returned, and retires discovered ones that were missed three runs in a row.
 */
export function mergeDiscovery({ found, containers, tailnetIps, okSources, now }: MergeInput): { summary: MergeSummary; keyOf: Map<string, string> } {
  const summary: MergeSummary = { created: 0, updated: 0, retired: 0, restored: 0 };
  /** The key each found target has in the table: a hostname that joined a Kuma monitor keeps the monitor's key. */
  const keyOf = new Map<string, string>();
  const stamp = new Date(now).toISOString();
  db.transaction(() => {
    const existing = db.select().from(monitorTargets).all();
    const byKey = new Map(existing.map((t) => [t.key, t]));
    const seen = new Set<string>();

    for (const f of found) {
      const target = byKey.get(f.key) ?? kumaTwin(existing, f);
      if (!target) {
        createTarget(f, now);
        keyOf.set(f.key, f.key);
        seen.add(f.key);
        summary.created++;
        continue;
      }
      if (target.retiredAt) summary.restored++;
      db.update(monitorTargets).set(updateFor(target, f, stamp)).where(eq(monitorTargets.key, target.key)).run();
      keyOf.set(f.key, target.key);
      seen.add(target.key);
      summary.updated++;
    }

    // Targets that discovery did not list, but whose container still exists: refresh what Docker says. Exited containers end up here.
    // A URL that names a container (http://app-1/) joins it too: the host cannot resolve that name, but the container's address works.
    const containerByName = new Map(containers.map((c) => [c.name, c]));
    for (const target of existing.filter((t) => !seen.has(t.key))) {
      const container = containerByName.get(target.container ?? (target.kind === "http" ? hostnameOf(target.url) ?? "" : ""));
      if (!container) continue;
      const facts = containerFacts(container, tailnetIps);
      const update: Update = isDiscovered(target)
        ? { containerInfo: facts.containerInfo }
        : { ...facts, dependsOn: union(target.dependsOn, [HOST_DEPENDENCY]), sources: union(target.sources, ["docker"]), ...(target.project === null && !target.userFields.includes("project") && { project: container.project }) };
      db.update(monitorTargets).set({ ...update, lastSeen: stamp, missedRuns: 0 }).where(eq(monitorTargets.key, target.key)).run();
      seen.add(target.key);
    }

    for (const target of existing.filter((t) => !seen.has(t.key) && isDiscovered(t) && !t.retiredAt)) {
      if (!target.sources.every((source) => okSources.has(source))) continue;
      const missedRuns = target.missedRuns + 1;
      if (missedRuns < MISSED_RUNS_TO_RETIRE) {
        db.update(monitorTargets).set({ missedRuns }).where(eq(monitorTargets.key, target.key)).run();
        continue;
      }
      db.update(monitorTargets).set({ missedRuns, retiredAt: stamp }).where(eq(monitorTargets.key, target.key)).run();
      closeIncidentOf(target.key, now);
      summary.retired++;
    }
  });
  return { summary, keyOf };
}

/**
 * Opens a warning for each finding, keeps its first-seen time while it lasts, and resolves open warnings of `resolveKinds`
 * that no finding repeats. Kinds not in `resolveKinds` are left as they are, and so are warnings `held` returns true for
 * (those of a host that is silent, which cannot say whether the condition is over).
 */
export function syncWarnings(findings: Finding[], resolveKinds: readonly string[], now: number, held: (warning: { targetKey: string | null }) => boolean = () => false): void {
  const stamp = new Date(now).toISOString();
  db.transaction(() => {
    const rows = new Map(db.select().from(monitorWarnings).all().map((row) => [row.key, row]));
    for (const f of findings) {
      const row = rows.get(f.key);
      if (!row) {
        db.insert(monitorWarnings).values({ ...f, firstSeen: stamp, lastSeen: stamp }).run();
      } else {
        // A warning that came back after being resolved is a new occurrence.
        db.update(monitorWarnings)
          .set({ kind: f.kind, targetKey: f.targetKey, text: f.text, lastSeen: stamp, ...(row.resolvedAt && { resolvedAt: null, firstSeen: stamp }) })
          .where(eq(monitorWarnings.key, f.key)).run();
      }
    }
    const current = new Set(findings.map((f) => f.key));
    for (const row of rows.values()) {
      if (row.resolvedAt || current.has(row.key) || !resolveKinds.includes(row.kind) || held(row)) continue;
      db.update(monitorWarnings).set({ resolvedAt: stamp }).where(eq(monitorWarnings.key, row.key)).run();
    }
  });
}
