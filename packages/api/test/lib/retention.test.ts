import { beforeEach, expect, test } from "vitest";
import { db } from "../../src/db/index.js";
import { agentSessions, proactiveRuleRuns, proactiveRules } from "../../src/db/schema.js";
import { compactIfBloated, pruneHistory } from "../../src/lib/retention.js";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z";
const RECENT = "2026-11-01T00:00:00.000Z";

beforeEach(() => {
  db.delete(proactiveRuleRuns).run();
  db.delete(proactiveRules).run();
  db.delete(agentSessions).run();
});

test("deletes only old skipped rule runs, and blanks only old finished session prompts", () => {
  db.insert(proactiveRules).values({ id: "r1", name: "rule", triggerType: "periodic", actionType: "agent" }).run();
  const run = (id: string, outcome: string, triggeredAt: string) =>
    db.insert(proactiveRuleRuns).values({ id, ruleId: "r1", triggerType: "periodic", outcome, triggeredAt }).run();
  run("old-skip", "skipped_cooldown", OLD);
  run("old-fired", "fired", OLD);
  run("old-error", "error", OLD);
  run("new-skip", "skipped_guard", RECENT);

  const session = (sessionId: string, startedAt: string, status: string) =>
    db.insert(agentSessions).values({ sessionId, agentName: "Alfred", agentType: "claude-sdk", status, startedAt, prompt: "big", userPrompt: "hi" }).run();
  session("old-done", OLD, "completed");
  session("old-running", OLD, "running");
  session("new-done", RECENT, "completed");

  expect(pruneHistory(NOW)).toEqual({ skippedRuns: 1, sessionPrompts: 1 });
  expect(db.select({ id: proactiveRuleRuns.id }).from(proactiveRuleRuns).all().map((r) => r.id).sort())
    .toEqual(["new-skip", "old-error", "old-fired"]);
  const prompts = Object.fromEntries(db.select().from(agentSessions).all().map((s) => [s.sessionId, s.prompt]));
  expect(prompts).toEqual({ "old-done": null, "old-running": "big", "new-done": "big" });
  // A second pass has nothing left to do.
  expect(pruneHistory(NOW)).toEqual({ skippedRuns: 0, sessionPrompts: 0 });
});

test("compacts only when free pages pass the threshold", () => {
  expect(compactIfBloated(Number.MAX_SAFE_INTEGER)).toBe(false);
  expect(compactIfBloated(0)).toBe(true);
});
