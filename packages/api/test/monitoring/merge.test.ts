import { beforeEach, describe, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { incidents, monitorRollups, monitorTargets, monitorWarnings } from "../../src/db/schema.js";
import type { Found } from "../../src/monitoring/discover.js";
import { syncIncident } from "../../src/monitoring/incidents.js";
import { MISSED_RUNS_TO_RETIRE, mergeDiscovery, syncWarnings, type MergeInput } from "../../src/monitoring/merge.js";
import { getTarget, patchTarget } from "../../src/monitoring/store.js";
import { addTarget, clearMonitoring, MINUTE, NOW } from "./helpers.js";
import { miniSnapshot } from "./fixtures.js";

beforeEach(() => clearMonitoring());

const iso = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
const ALL_OK = new Set(["traefik", "cloudflare", "dns", "docker", "listener"]);
const containers = miniSnapshot().containers;

const found = (over: Partial<Found> & { key: string }): Found => ({
  title: over.key, kind: "http", url: `https://${over.key}`, host: "mini", port: 3000, bindAddress: null, container: null, image: null,
  systemdUnit: null, project: null, sources: ["traefik"], dependsOn: ["host:mini", "infra:traefik"], exposure: "lan", tracked: true,
  hidden: false, containerInfo: null, ...over,
});

/** One discovery run `minutes` after the start. */
const merge = (list: Found[], minutes = 0, over: Partial<MergeInput> = {}) =>
  mergeDiscovery({ found: list, containers: [], tailnetIps: [], okSources: ALL_OK, now: NOW + minutes * MINUTE, ...over });

describe("adding and refreshing", () => {
  test("a found target is stored with everything discovery knows", () => {
    const result = merge([found({ key: "app.example.com", container: "app", image: "app:1", project: "app", port: 3000, bindAddress: "0.0.0.0", exposure: "public-tunnel", sources: ["traefik", "cloudflare"] })]);
    expect(result.summary).toEqual({ created: 1, updated: 0, retired: 0, restored: 0 });
    expect(getTarget("app.example.com")).toMatchObject({
      title: "app.example.com", kind: "http", url: "https://app.example.com", host: "mini", port: 3000, bindAddress: "0.0.0.0", container: "app", image: "app:1",
      project: "app", exposure: "public-tunnel", sources: ["traefik", "cloudflare"], dependsOn: ["host:mini", "infra:traefik"], tracked: true, hidden: false,
      userFields: [], missedRuns: 0, retiredAt: null, firstSeen: new Date(NOW).toISOString(), status: "unknown",
    });
  });

  test("the next run updates it: facts change, first seen stays, last seen moves", () => {
    merge([found({ key: "a", port: 3000, image: "a:1" })]);
    const result = merge([found({ key: "a", port: 4000, image: "a:2", exposure: "tailnet" })], 5);
    expect(result.summary).toMatchObject({ created: 0, updated: 1 });
    expect(getTarget("a")).toMatchObject({ port: 4000, image: "a:2", exposure: "tailnet", firstSeen: new Date(NOW).toISOString(), lastSeen: new Date(NOW + 5 * MINUTE).toISOString() });
  });

  test("a run leaves what the checks decided alone: status, since and last check", () => {
    merge([found({ key: "a" })]);
    db.update(monitorTargets).set({ status: "down", statusSince: iso(1), lastCheckedAt: NOW + MINUTE }).run();
    merge([found({ key: "a" })], 5);
    expect(getTarget("a")).toMatchObject({ status: "down", statusSince: iso(1), lastCheckedAt: NOW + MINUTE });
  });
});

describe("what a person edited stays", () => {
  test("PATCH marks the fields, and the next run leaves them", () => {
    merge([found({ key: "a", title: "a.example.com", project: "old", tracked: true, hidden: false })]);
    patchTarget("a", { title: "My app", tracked: false, hidden: true, project: "mine", notes: "check me", expectedStatus: 401 });
    expect(getTarget("a")!.userFields.sort()).toEqual(["expectedStatus", "hidden", "notes", "project", "title", "tracked"]);
    merge([found({ key: "a", title: "new title", project: "new", tracked: true, hidden: false })], 5);
    expect(getTarget("a")).toMatchObject({ title: "My app", tracked: false, hidden: true, project: "mine", notes: "check me", expectedStatus: 401 });
  });

  test("fields the person did not touch keep following discovery", () => {
    merge([found({ key: "a", title: "one", project: "p1", tracked: false, hidden: true })]);
    patchTarget("a", { notes: "x" });
    merge([found({ key: "a", title: "two", project: "p2", tracked: true, hidden: false })], 5);
    expect(getTarget("a")).toMatchObject({ title: "two", project: "p2", tracked: true, hidden: false, notes: "x", userFields: ["notes"] });
  });

  test("editing a field twice is still one entry", () => {
    merge([found({ key: "a" })]);
    patchTarget("a", { title: "x" });
    patchTarget("a", { title: "y" });
    expect(getTarget("a")!.userFields).toEqual(["title"]);
  });
});

describe("Kuma monitors", () => {
  const kuma = (over = {}) => addTarget({ key: "shop-fit", title: "apps.example.net", url: "https://apps.example.net/", sources: ["kuma:3"], project: null, ...over });

  test("a found hostname joins the Kuma monitor of the same hostname instead of making a twin", () => {
    kuma();
    const result = merge([found({ key: "apps.example.net", container: "shop", image: "shop:1", exposure: "public-tunnel", sources: ["traefik", "cloudflare"], project: "shop" })]);
    expect(result.summary).toMatchObject({ created: 0, updated: 1 });
    expect(result.keyOf.get("apps.example.net")).toBe("shop-fit");
    expect(getTarget("apps.example.net")).toBeUndefined();
    expect(getTarget("shop-fit")).toMatchObject({
      title: "apps.example.net", url: "https://apps.example.net/", tracked: true, kind: "http",
      container: "shop", image: "shop:1", exposure: "public-tunnel", project: "shop", sources: ["kuma:3", "traefik", "cloudflare"],
    });
  });

  test("it keeps the Kuma monitor's own title, URL and tracking, whatever discovery wants", () => {
    kuma({ title: "Main site" });
    merge([found({ key: "apps.example.net", title: "apps.example.net", tracked: false, hidden: true, url: "https://apps.example.net" })]);
    expect(getTarget("shop-fit")).toMatchObject({ title: "Main site", url: "https://apps.example.net/", tracked: true, hidden: false });
  });

  test("a project the person set is not replaced", () => {
    kuma({ project: "Mine" });
    patchTarget("shop-fit", { project: "Mine" });
    merge([found({ key: "apps.example.net", project: "shop" })]);
    expect(getTarget("shop-fit")!.project).toBe("Mine");
  });

  test("the hostname is matched without regard to case or path, and only against Kuma's HTTP monitors", () => {
    kuma({ url: "https://Apps.Example.Net/status?x=1" });
    addTarget({ key: "by-hand", url: "https://other.example.com/" }); // not from Kuma: left alone, and gets its own twin
    merge([found({ key: "apps.example.net" }), found({ key: "other.example.com" })]);
    expect(getTarget("shop-fit")!.sources).toContain("traefik");
    expect(getTarget("other.example.com")).toBeDefined();
  });

  test("a Kuma monitor is never retired, however long discovery misses it", () => {
    kuma();
    for (let run = 0; run < 6; run++) merge([], run * 5);
    expect(getTarget("shop-fit")).toMatchObject({ retiredAt: null, missedRuns: 0 });
  });

  test("a URL that names a container is linked to it, so the check can reach the container's address", () => {
    addTarget({ key: "shop-app", title: "shop app", url: "http://shop-app-app-1/", sources: ["kuma:9"] });
    addTarget({ key: "rocket", url: "http://rocket-backend-orbitapi-1:6000/health", sources: ["kuma:10"] });
    addTarget({ key: "elsewhere", url: "https://example.com/", sources: ["kuma:11"] });
    merge([], 0, { containers });
    const app = getTarget("shop-app")!;
    expect(app).toMatchObject({ container: "shop-app-app-1", image: "shop-app-app", project: "shop-app", exposure: "local", sources: ["kuma:9", "docker"], dependsOn: ["host:mini"] });
    expect(app.containerInfo).toMatchObject({ state: "running", health: null, restarts: 0, oomKilled: false });
    expect(app.containerInfo!.ip).toMatch(/^172\.\d+\.\d+\.\d+$/);
    expect(getTarget("rocket")).toMatchObject({ container: "rocket-backend-orbitapi-1" });
    expect(getTarget("rocket")!.containerInfo!.ip).toMatch(/^172\./);
    expect(getTarget("elsewhere")!.container).toBeNull();
    expect(app).toMatchObject({ title: "shop app", url: "http://shop-app-app-1/", tracked: true });
  });
});

describe("retiring", () => {
  const run = (minute: number, list: Found[], over: Partial<MergeInput> = {}) => merge(list, minute * 5, over);

  test("a discovered target missed three runs in a row is retired, and not before", () => {
    run(0, [found({ key: "a" })]);
    run(1, []);
    run(2, []);
    expect(getTarget("a")).toMatchObject({ retiredAt: null, missedRuns: 2 });
    const result = run(3, []);
    expect(MISSED_RUNS_TO_RETIRE).toBe(3);
    expect(result.summary.retired).toBe(1);
    expect(getTarget("a")).toMatchObject({ retiredAt: new Date(NOW + 15 * MINUTE).toISOString(), missedRuns: 3 });
  });

  test("being seen again resets the count", () => {
    run(0, [found({ key: "a" })]);
    run(1, []);
    run(2, []);
    run(3, [found({ key: "a" })]);
    run(4, []);
    expect(getTarget("a")).toMatchObject({ retiredAt: null, missedRuns: 1 });
  });

  test("a retired target that returns is brought back, with its history", () => {
    run(0, [found({ key: "a" })]);
    db.insert(monitorRollups).values({ targetKey: "a", hour: NOW, up: 60, down: 0 }).run();
    for (let i = 1; i <= 3; i++) run(i, []);
    const result = run(4, [found({ key: "a" })]);
    expect(result.summary).toMatchObject({ restored: 1, created: 0 });
    expect(db.select().from(monitorRollups).all()).toHaveLength(1);
    expect(getTarget("a")).toMatchObject({ retiredAt: null, missedRuns: 0, firstSeen: new Date(NOW).toISOString() });
  });

  test("a target made by hand is never retired", () => {
    addTarget({ key: "hand" });
    for (let i = 0; i < 5; i++) run(i, []);
    expect(getTarget("hand")).toMatchObject({ retiredAt: null, missedRuns: 0 });
  });

  test("a run in which a source failed does not count against what that source found", () => {
    run(0, [found({ key: "web", sources: ["traefik"] }), found({ key: "mini:5433", sources: ["docker"] })]);
    const docker = new Set(["traefik", "cloudflare", "dns", "listener"]); // docker did not answer
    for (let i = 1; i <= 4; i++) run(i, [], { okSources: docker });
    expect(getTarget("mini:5433")).toMatchObject({ retiredAt: null, missedRuns: 0 });
    expect(getTarget("web")!.retiredAt).not.toBeNull();
  });

  test("a target found by Traefik and the tunnel is only missed when both answered", () => {
    run(0, [found({ key: "web", sources: ["traefik", "cloudflare"] })]);
    for (let i = 1; i <= 4; i++) run(i, [], { okSources: new Set(["traefik"]) });
    expect(getTarget("web")).toMatchObject({ retiredAt: null, missedRuns: 0 });
  });

  test("retiring ends the target's open incident", () => {
    run(0, [found({ key: "a", title: "A" })]);
    syncIncident(getTarget("a")!, "down", "HTTP 502", NOW);
    syncIncident(getTarget("a")!, "down", "HTTP 502", NOW + MINUTE); // an incident opens one cycle after the target went down
    expect(db.select().from(incidents).get()!.state).toBe("open");
    for (let i = 1; i <= 3; i++) run(i, []);
    expect(db.select().from(incidents).get()).toMatchObject({ state: "resolved", endedAt: new Date(NOW + 15 * MINUTE).toISOString() });
  });
});

describe("containers", () => {
  test("a target whose container exited is not retired, and shows the container as exited", () => {
    const running = containers.find((c) => c.name === "redis")!;
    merge([found({ key: "mini:6379", kind: "tcp", url: null, container: "redis", sources: ["docker"], containerInfo: { state: "running", health: null, restarts: 0, oomKilled: false, ip: "172.17.0.2" } })]);
    const exited = { ...running, state: "exited", ports: [] };
    for (let i = 1; i <= 5; i++) merge([], i * 5, { containers: containers.map((c) => (c.name === "redis" ? exited : c)) });
    expect(getTarget("mini:6379")).toMatchObject({ retiredAt: null, missedRuns: 0, containerInfo: { state: "exited" } });
  });

  test("when the container is gone too, the target is retired as any other", () => {
    merge([found({ key: "mini:6379", container: "redis", sources: ["docker"] })]);
    for (let i = 1; i <= 3; i++) merge([], i * 5, { containers: containers.filter((c) => c.name !== "redis") });
    expect(getTarget("mini:6379")!.retiredAt).not.toBeNull();
  });

  test("restarts and OOM kills are recorded on the target", () => {
    merge([found({ key: "mini:6379", container: "redis", sources: ["docker"], containerInfo: { state: "running", health: null, restarts: 0, oomKilled: false, ip: null } })]);
    merge([found({ key: "mini:6379", container: "redis", sources: ["docker"], containerInfo: { state: "running", health: "unhealthy", restarts: 4, oomKilled: true, ip: null } })], 5);
    expect(getTarget("mini:6379")!.containerInfo).toMatchObject({ health: "unhealthy", restarts: 4, oomKilled: true });
  });
});

describe("warnings", () => {
  const rows = () => db.select().from(monitorWarnings).all();
  const finding = (key: string, text = "text") => ({ key, kind: "database-open-lan", targetKey: "mini:5433", text });
  const T0 = NOW;

  test("a finding opens a warning, and a repeat keeps its first-seen time and moves its last-seen time", () => {
    syncWarnings([finding("w1")], ["database-open-lan"], T0);
    syncWarnings([finding("w1", "new text")], ["database-open-lan"], T0 + 5 * MINUTE);
    expect(rows()).toEqual([{ key: "w1", kind: "database-open-lan", targetKey: "mini:5433", text: "new text", firstSeen: iso(0), lastSeen: iso(5), resolvedAt: null, notifiedAt: null, muted: false }]);
  });

  test("a warning the rules stop reporting is resolved, and one that comes back starts again", () => {
    syncWarnings([finding("w1")], ["database-open-lan"], T0);
    syncWarnings([], ["database-open-lan"], T0 + 5 * MINUTE);
    expect(rows()[0]).toMatchObject({ resolvedAt: iso(5), firstSeen: iso(0) });
    syncWarnings([finding("w1")], ["database-open-lan"], T0 + 10 * MINUTE);
    expect(rows()[0]).toMatchObject({ resolvedAt: null, firstSeen: iso(10), lastSeen: iso(10) });
  });

  test("only the kinds that could be evaluated are resolved: a rule whose source failed keeps its warnings", () => {
    syncWarnings([finding("w1"), { key: "docker-reclaimable", kind: "docker-reclaimable", targetKey: null, text: "t" }], ["database-open-lan", "docker-reclaimable"], T0);
    syncWarnings([], ["database-open-lan"], T0 + 5 * MINUTE);
    expect(Object.fromEntries(rows().map((r) => [r.key, r.resolvedAt]))).toEqual({ w1: iso(5), "docker-reclaimable": null });
  });

  test("a warning of another phase's kind is never resolved by discovery", () => {
    db.insert(monitorWarnings).values({ key: "disk:mini", kind: "disk-high", text: "86%", firstSeen: iso(0), lastSeen: iso(0) }).run();
    syncWarnings([], ["database-open-lan", "docker-reclaimable"], T0 + 5 * MINUTE);
    expect(rows()[0].resolvedAt).toBeNull();
  });

  test("a muted warning stays muted and a notified one stays notified when it repeats", () => {
    syncWarnings([finding("w1")], ["database-open-lan"], T0);
    db.update(monitorWarnings).set({ muted: true, notifiedAt: iso(1) }).run();
    syncWarnings([finding("w1")], ["database-open-lan"], T0 + 5 * MINUTE);
    expect(rows()[0]).toMatchObject({ muted: true, notifiedAt: iso(1) });
  });
});
