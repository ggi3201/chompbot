import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChompEvent } from "@chomp/shared";

const alerts = vi.hoisted(() => ({ notifyIncident: vi.fn(), resetAlertState: vi.fn() }));
vi.mock("../../src/monitoring/alerts.js", () => alerts);

import { db } from "../../src/db/index.js";
import { incidentEvents, incidents, incidentTargets } from "../../src/db/schema.js";
import { off, on } from "../../src/events/bus.js";
import {
  applyStatusChange, closeIncidentOf, getIncident, listIncidents, openHostIncident, resolveHostIncident, settleIncidents,
  type Vantage,
} from "../../src/monitoring/incidents.js";
import { addTarget, clearMonitoring, MINUTE, NOW } from "./helpers.js";

const at = (seconds: number) => NOW + seconds * 1000;
const change = (vantage: Vantage, status: "up" | "down", key: string, now: number, error: string | null = "HTTP 502") =>
  applyStatusChange({ key }, { vantage, status, error }, now);
const down = (key: string, now: number, error?: string | null) => change("home", "down", key, now, error);
const up = (key: string, now: number) => change("home", "up", key, now, null);

const all = () => db.select().from(incidents).all();
const kinds = (incidentId?: string) => db.select().from(incidentEvents).all().filter((e) => !incidentId || e.incidentId === incidentId).map((e) => e.kind);
const notices = () => alerts.notifyIncident.mock.calls.map((call) => call[1]);

let busEvents: ChompEvent[] = [];
const record = (event: ChompEvent) => { busEvents.push(event); };

beforeEach(() => {
  clearMonitoring();
  busEvents = [];
  on(record);
});
afterEach(() => off(record));

describe("opening", () => {
  test("a tracked target that stays down for a cycle opens one incident, and not before", () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    down("web", at(0));
    down("web", at(59));
    expect(all()).toHaveLength(0);
    down("web", at(60), "HTTP 502");
    const [incident] = all();
    expect(incident).toMatchObject({ title: "Web is down", causeKey: "web", state: "open", startedAt: new Date(at(60)).toISOString() });
    expect(kinds()).toEqual(["opened"]);
    expect(notices()).toEqual(["opened"]);
    expect(busEvents).toEqual([{ type: "monitoring.incident.opened", incidentId: incident.id, title: "Web is down", causeKey: "web", targetKeys: ["web"] }]);
    down("web", at(120));
    expect(all()).toHaveLength(1);
  });

  test("a target that comes back inside the cycle never opens an incident", () => {
    addTarget({ key: "web", status: "down" });
    down("web", at(0));
    up("web", at(30));
    down("web", at(40));
    down("web", at(80)); // only 40 s since it went down again
    expect(all()).toHaveLength(0);
  });

  test("an untracked target opens nothing and joins nothing", () => {
    addTarget({ key: "host:mini", title: "mini", kind: "host", status: "down" });
    addTarget({ key: "quiet", tracked: false, status: "down", dependsOn: ["host:mini"] });
    addTarget({ key: "loud", status: "down", dependsOn: ["host:mini"] });
    down("quiet", at(0));
    down("quiet", at(60));
    expect(all()).toHaveLength(0);
    down("loud", at(60));
    down("loud", at(120));
    down("quiet", at(180));
    expect(db.select().from(incidentTargets).all().map((t) => t.targetKey)).toEqual(["loud"]);
  });
});

describe("cause", () => {
  test("services behind a host that is down open one incident for the host, and the rest join it", () => {
    addTarget({ key: "host:mini", title: "mini", kind: "host", status: "down" });
    for (const key of ["a", "b", "c"]) addTarget({ key, status: "down", dependsOn: ["host:mini"] });
    for (const [i, key] of ["a", "b", "c"].entries()) down(key, at(i * 10));
    down("a", at(60));
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ causeKey: "host:mini", title: "mini is down" });
    down("b", at(70));
    down("c", at(80));
    expect(all()).toHaveLength(1);
    expect(db.select().from(incidentTargets).all().map((t) => t.targetKey)).toEqual(["a", "b", "c"]);
    expect(kinds()).toEqual(["opened", "joined", "joined"]);
    expect(notices()).toEqual(["opened", "changed", "changed"]);
    expect(busEvents.filter((e) => e.type === "monitoring.incident.opened")).toHaveLength(1);
  });

  test("when every service behind Traefik is down, Traefik is the cause, even with no target of its own", () => {
    addTarget({ key: "x", status: "down", dependsOn: ["host:mini", "infra:traefik"] });
    addTarget({ key: "y", status: "down", dependsOn: ["host:mini", "infra:traefik"] });
    addTarget({ key: "lan", status: "up", dependsOn: ["host:mini"] });
    down("x", at(0));
    down("x", at(60));
    expect(all()[0]).toMatchObject({ causeKey: "infra:traefik", title: "Traefik is down" });
    expect(getIncident(all()[0].id)?.cause).toBe("Traefik");
  });

  test("the host wins over Traefik and the tunnel when everything on it is down", () => {
    for (const key of ["x", "y"]) addTarget({ key, status: "down", dependsOn: ["host:mini", "infra:traefik", "infra:tunnel"] });
    down("x", at(0));
    down("x", at(60));
    expect(all()[0]).toMatchObject({ causeKey: "host:mini", title: "Everything on mini is down" });
  });

  test("the tunnel is the cause when only the services behind it are down", () => {
    for (const key of ["x", "y"]) addTarget({ key, status: "down", dependsOn: ["host:mini", "infra:traefik", "infra:tunnel"] });
    addTarget({ key: "z", status: "up", dependsOn: ["host:mini", "infra:traefik"] });
    down("x", at(0));
    down("x", at(60));
    expect(all()[0]).toMatchObject({ causeKey: "infra:tunnel", title: "Cloudflare tunnel is down" });
  });

  test("one service down behind a working Traefik is its own cause", () => {
    addTarget({ key: "x", status: "down", dependsOn: ["host:mini", "infra:traefik"] });
    addTarget({ key: "y", status: "up", dependsOn: ["host:mini", "infra:traefik"] });
    down("x", at(0));
    down("x", at(60));
    expect(all()[0]).toMatchObject({ causeKey: "x", title: "x is down" });
  });
});

describe("recovery", () => {
  test("a partly recovered incident stays open, and ends when the last service is up", () => {
    addTarget({ key: "host:mini", title: "mini", kind: "host", status: "down" });
    for (const key of ["a", "b"]) addTarget({ key, status: "down", dependsOn: ["host:mini"] });
    for (const key of ["a", "b"]) { down(key, at(0)); down(key, at(60)); }
    up("a", at(300));
    expect(all()[0]).toMatchObject({ state: "open", endedAt: null });
    expect(kinds()).toEqual(["opened", "joined", "up"]);
    up("b", at(360));
    expect(all()[0]).toMatchObject({ state: "resolved", endedAt: new Date(at(360)).toISOString() });
    expect(kinds().slice(-2)).toEqual(["recovered", "resolved"]);
    expect(getIncident(all()[0].id)?.events.at(-1)?.text).toBe("Recovered after 5 min");
    expect(notices()).toEqual(["opened", "changed", "changed", "resolved"]);
    expect(busEvents.at(-1)).toMatchObject({ type: "monitoring.incident.resolved", title: "mini is down", durationMs: 5 * MINUTE });
  });

  test("a service that goes down again while the incident is open rejoins it", () => {
    addTarget({ key: "host:mini", title: "mini", kind: "host", status: "down" });
    for (const key of ["a", "b"]) addTarget({ key, status: "down", dependsOn: ["host:mini"] });
    for (const key of ["a", "b"]) { down(key, at(0)); down(key, at(60)); }
    up("a", at(100));
    down("a", at(200));
    down("a", at(260));
    expect(db.select().from(incidentTargets).all().find((t) => t.targetKey === "a")?.upAt).toBeNull();
    expect(kinds()).toEqual(["opened", "joined", "up", "joined"]);
  });

  test("retiring a target ends its incident", () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    down("web", at(0));
    down("web", at(60));
    closeIncidentOf("web", at(120));
    expect(all()[0]).toMatchObject({ state: "resolved" });
    expect(getIncident(all()[0].id)?.events.at(-1)?.text).toBe("Closed: Web is gone");
  });
});

describe("outside", () => {
  test("an outside failure with home up opens its own incident, and an outside pass ends it", () => {
    addTarget({ key: "web", title: "Web", status: "up", exposure: "public-tunnel" });
    change("outside", "down", "web", at(0), "timeout");
    expect(all()[0]).toMatchObject({ causeKey: "outside:web", title: "Web unreachable from outside", state: "open" });
    expect(getIncident(all()[0].id)).toMatchObject({ cause: "Web from outside", msg: "timeout" });
    change("outside", "up", "web", at(180), null);
    expect(all()[0]).toMatchObject({ state: "resolved" });
  });

  test("an outside failure while home is down opens nothing: the home incident tells the story", () => {
    addTarget({ key: "web", status: "down" });
    change("outside", "down", "web", at(0));
    change("outside", "down", "web", at(60));
    expect(all()).toHaveLength(0);
  });

  test("a home pass does not end an outside incident, and the two do not mix", () => {
    addTarget({ key: "web", status: "up" });
    change("outside", "down", "web", at(0));
    change("outside", "down", "web", at(60));
    up("web", at(90));
    expect(all()[0]).toMatchObject({ state: "open" });
    down("web", at(100));
    down("web", at(160));
    expect(all()).toHaveLength(2);
  });
});

describe("flapping", () => {
  /** Down for a cycle, then up, as a flapping service does. */
  const cycle = (key: string, startMin: number, upMin: number) => {
    down(key, at(startMin * 60));
    down(key, at(startMin * 60 + 60));
    up(key, at(upMin * 60));
  };

  test("a service that comes back inside 15 minutes reopens its incident instead of making a new one", () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    cycle("web", 0, 5);
    expect(all()[0]).toMatchObject({ state: "resolved" });
    down("web", at(6 * 60));
    down("web", at(7 * 60));
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ state: "open", endedAt: null });
    expect(kinds()).toEqual(["opened", "recovered", "resolved", "reopened"]);
    expect(notices().at(-1)).toBe("reopened");
  });

  test("a service that comes back after 15 minutes of quiet is a new incident", () => {
    addTarget({ key: "web", status: "down" });
    cycle("web", 0, 5);
    cycle("web", 21, 25);
    expect(all()).toHaveLength(2);
  });

  test("4 state changes in 30 minutes mark the incident as flapping and hold it open", () => {
    addTarget({ key: "web", title: "Web", status: "down" });
    cycle("web", 0, 5); // opened, recovered
    cycle("web", 6, 10); // reopened, recovered
    const [incident] = all();
    expect(incident).toMatchObject({ state: "open", flapping: true });
    expect(notices().at(-1)).toBe("flapping");
    expect(kinds()).toContain("flapping");
    expect(listIncidents({ now: at(11 * 60) })[0]).toMatchObject({ flapping: true, state: "open" });
  });

  test("a flapping incident ends after 15 quiet minutes, and says so once", () => {
    addTarget({ key: "web", status: "down" });
    cycle("web", 0, 5);
    cycle("web", 6, 10);
    settleIncidents(at(24 * 60));
    expect(all()[0]).toMatchObject({ state: "open", flapping: true });
    settleIncidents(at(25 * 60));
    expect(all()[0]).toMatchObject({ state: "resolved", flapping: false });
    expect(kinds().slice(-2)).toEqual(["stable", "resolved"]);
    expect(notices().at(-1)).toBe("resolved");
    settleIncidents(at(60 * 60));
    expect(notices().filter((n) => n === "resolved")).toHaveLength(2); // the first recovery, and this one
  });

  test("a flapping incident that is down when it settles stays open and speaks again", () => {
    addTarget({ key: "web", status: "down" });
    cycle("web", 0, 5);
    cycle("web", 6, 10);
    down("web", at(11 * 60));
    down("web", at(12 * 60));
    settleIncidents(at(27 * 60));
    expect(all()[0]).toMatchObject({ state: "open", flapping: false });
    expect(notices().at(-1)).toBe("stable");
  });
});

describe("host incidents", () => {
  test("a host threshold opens one incident without services, and resolves it", () => {
    const id = openHostIncident("mini", "disk", "mini disk is 94% full", at(0));
    expect(openHostIncident("mini", "disk", "mini disk is 95% full", at(60))).toBe(id);
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ title: "mini disk is 94% full", causeKey: "host:mini:disk", state: "open" });
    expect(getIncident(id)).toMatchObject({ targets: [], cause: "mini disk" });
    expect(busEvents[0]).toMatchObject({ type: "monitoring.incident.opened", targetKeys: [] });

    expect(resolveHostIncident("mini", "disk", at(10 * 60))).toBe(true);
    expect(all()[0]).toMatchObject({ state: "resolved" });
    expect(getIncident(id)?.events.at(-1)?.text).toBe("Recovered after 10 min");
    expect(resolveHostIncident("mini", "disk", at(11 * 60))).toBe(false);
    expect(openHostIncident("mini", "memory", "mini memory is 98% used", at(12 * 60))).not.toBe(id);
  });
});
