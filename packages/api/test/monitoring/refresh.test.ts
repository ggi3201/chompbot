import { beforeEach, expect, test } from "vitest";
import { runAllChecks, runDueChecks } from "../../src/monitoring/engine.js";
import { addTarget, clearMonitoring, MINUTE, NOW } from "./helpers.js";

beforeEach(clearMonitoring);

test("Refresh checks every target, also those checked a moment ago; the timer only checks what is due", async () => {
  // Push targets are checked without the network, so the test sees only the selection.
  addTarget({ key: "job-due", kind: "push", pushIntervalSec: 3600, lastPushAt: NOW, lastCheckedAt: NOW - 2 * MINUTE });
  addTarget({ key: "job-fresh", kind: "push", pushIntervalSec: 3600, lastPushAt: NOW, lastCheckedAt: NOW - 10_000 });
  addTarget({ key: "gone", kind: "push", pushIntervalSec: 3600, lastPushAt: NOW, retiredAt: new Date(NOW).toISOString() });

  expect(await runDueChecks(NOW)).toBe(1);
  expect(await runAllChecks(NOW)).toBe(2);
});
