import { beforeEach, describe, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { incidents } from "../../src/db/schema.js";
import { noteArrival, recordMetrics, syncHostWarnings } from "../../src/monitoring/hosts.js";
import { onOutsideStatusChange } from "../../src/monitoring/outside-hook.js";
import { addTarget, clearMonitoring, MINUTE, NOW } from "./helpers.js";

beforeEach(clearMonitoring);

const all = () => db.select().from(incidents).all();

describe("incidents from the other phases", () => {
  test("a tracked public target that fails from outside while up at home opens an incident at once", () => {
    const target = addTarget({ key: "recipes.apps.example.org", tracked: true, status: "up" });
    onOutsideStatusChange(target, "down", "HTTP 530", NOW);
    expect(all()).toMatchObject([{ title: "recipes.apps.example.org unreachable from outside", state: "open" }]);

    onOutsideStatusChange(target, "up", null, NOW + 5 * MINUTE);
    expect(all()).toMatchObject([{ state: "resolved" }]);
  });

  test("a critical disk opens a host incident, and it resolves when the disk is below the line again", () => {
    recordMetrics("rpi", { disk_pct: 95 }, NOW);
    noteArrival("rpi", NOW);
    syncHostWarnings(NOW);
    expect(all()).toMatchObject([{ causeKey: "host:rpi:disk", state: "open" }]);

    recordMetrics("rpi", { disk_pct: 60 }, NOW + MINUTE);
    noteArrival("rpi", NOW + MINUTE);
    syncHostWarnings(NOW + MINUTE);
    expect(all()).toMatchObject([{ causeKey: "host:rpi:disk", state: "resolved" }]);
  });
});
