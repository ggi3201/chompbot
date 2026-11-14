import { describe, expect, it } from "vitest";
import { activeWindow, describeAction, describeTrigger, guardNotes, lastResultByRule, ruleStatus, type RuleShape } from "../../src/lib/proactive";

const rule = (over: Partial<RuleShape>): RuleShape => ({
  triggerType: "periodic",
  condition: {},
  actionType: "run_agent",
  actionConfig: {},
  cooldownMinutes: 60,
  activeHours: {},
  notificationChannels: ["telegram"],
  ...over,
});

describe("describeTrigger", () => {
  it("names a daily rule by its window: a range, a single hour with the zone, or no window for a full day", () => {
    expect(describeTrigger(rule({ cooldownMinutes: 1380, activeHours: { start: 7, end: 8 } }))).toBe("Daily · 07:00–09:00");
    expect(describeTrigger(rule({ cooldownMinutes: 1380, activeHours: { start: 12, end: 12, timezone: "Europe/Oslo" } }))).toBe("Daily · 12:00 Oslo");
    expect(activeWindow({ start: 0, end: 23 })).toBeNull();
    expect(describeTrigger(rule({ cooldownMinutes: 20, activeHours: { start: 0, end: 23 } }))).toBe("Every 20 min");
  });

  it("calls a cooldown by its length, and a jittered rule by its range", () => {
    expect(describeTrigger(rule({ cooldownMinutes: 5760 }))).toBe("Every 4 days");
    expect(describeTrigger(rule({ cooldownMinutes: 10080 }))).toBe("Weekly");
    expect(describeTrigger(rule({ condition: { scheduleMode: "jittered", jitterMinMinutes: 90, jitterMaxMinutes: 240 } }))).toBe("Every 1h 30m–4h");
  });

  it("describes event rules with their filter count, and one-offs by their time", () => {
    const r = rule({ triggerType: "event", condition: { eventType: "webhook.received", conditions: [{}, {}] } });
    expect(describeTrigger(r)).toBe("On webhook.received · 2 filters");
    expect(describeTrigger(rule({ triggerType: "event" }))).toBe("On any event");
    expect(describeTrigger(rule({ runAt: "2026-11-10T08:30:00.000Z" }))).toMatch(/^Once, /);
  });
});

describe("guardNotes and describeAction", () => {
  it("turns a market session guard into a short note, and names the model and the gate script", () => {
    const r = rule({ condition: { guard: { mode: "all", rules: [{ type: "market_session", market: "XNAS", phase: "regular" }, { type: "weekday" }] } } });
    expect(guardNotes(r)).toEqual(["XNAS open", "weekday"]);
    expect(describeAction(rule({ actionConfig: { provider: "claude", model: "opus" } }))).toBe("Agent · opus");
    expect(describeAction(rule({ actionType: "script_gate", actionConfig: { script: "company_news_scan" } }))).toBe("Gate: company news scan");
  });
});

describe("rule status", () => {
  const run = (ruleId: string, triggeredAt: string, outcome: string) => ({ ruleId, triggeredAt, outcome });

  it("uses the latest fired or failed run and ignores skips after it", () => {
    const latest = lastResultByRule([
      run("a", "2026-11-03T10:00:00Z", "error"),
      run("a", "2026-11-03T11:00:00Z", "skipped_cooldown"),
      run("b", "2026-11-03T09:00:00Z", "fired"),
      run("b", "2026-11-03T08:00:00Z", "error"),
    ]);
    expect(ruleStatus(latest.get("a"))).toBe("error");
    expect(ruleStatus(latest.get("b"))).toBe("ok");
    expect(ruleStatus(latest.get("c"))).toBe("idle");
  });
});
