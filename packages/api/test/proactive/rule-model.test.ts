import { test, expect } from "vitest";
import {
  parseStoredActiveHours,
  parseStoredNotificationChannels,
  parseStoredProactiveRule,
  validateCreateProactiveRule,
  validateUpdateProactiveRule,
  type ProactiveRuleRow,
} from "../../src/proactive/rule-model.js";

function makeRule(overrides: Partial<ProactiveRuleRow> = {}): ProactiveRuleRow {
  return {
    id: "rule-1",
    name: "Morning brief",
    triggerType: "periodic",
    condition: "{}",
    actionType: "run_agent",
    actionConfig: "{}",
    enabled: true,
    cooldownMinutes: 60,
    activeHours: "{}",
    priority: 0,
    notificationChannels: '["telegram"]',
    runAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: "2026-05-03T10:00:00.000Z",
    updatedAt: "2026-05-03T10:00:00.000Z",
    ...overrides,
  };
}

test("validateCreateProactiveRule applies defaults and normalizes action config", () => {
  const result = validateCreateProactiveRule({
    name: "Daily cleanup",
    triggerType: "periodic",
    actionType: "run_agent",
    actionConfig: { agent: "Claude Code", model: "sonnet", retries: 2, prompt: null },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.value.enabled).toBe(true);
  expect(result.value.cooldownMinutes).toBe(60);
  expect(result.value.activeHours).toEqual({});
  expect(result.value.notificationChannels).toEqual(["telegram"]);
  expect(result.value.actionConfig).toEqual({
    agent: "Claude Code",
    model: "sonnet",
    retries: "2",
  });
});

test("validateCreateProactiveRule accepts script gate action config", () => {
  const result = validateCreateProactiveRule({
    name: "ACME gate",
    triggerType: "periodic",
    actionType: "script_gate",
    actionConfig: {
      script: "market_quote_threshold",
      input: { ticker: "ACME", buyBelow: 55 },
      onTrue: { agent: "Alfred", prompt: "Gate fired:\n{{gateResult}}" },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.actionConfig).toEqual({
    script: "market_quote_threshold",
    input: { ticker: "ACME", buyBelow: 55 },
    onTrue: { agent: "Alfred", prompt: "Gate fired:\n{{gateResult}}" },
  });
});

test("validateCreateProactiveRule accepts grouped script gate conditions", () => {
  const result = validateCreateProactiveRule({
    name: "KTOS reversal gate",
    triggerType: "periodic",
    actionType: "script_gate",
    actionConfig: {
      script: "market_quote_threshold",
      input: {
        ticker: "KTOS",
        groups: [{
          label: "confirmed reversal band",
          conditions: [
            { field: "price", op: "gte", value: 58 },
            { field: "price", op: "lte", value: 60 },
            { field: "volume", op: "gte", value: 5_000_000 },
          ],
        }],
      },
      onTrue: { agent: "Alfred", prompt: "Gate fired:\n{{gateResult}}" },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.actionConfig.input).toEqual({
    ticker: "KTOS",
    groups: [{
      label: "confirmed reversal band",
      conditions: [
        { field: "price", op: "gte", value: 58 },
        { field: "price", op: "lte", value: 60 },
        { field: "volume", op: "gte", value: 5_000_000 },
      ],
    }],
  });
});

test("validateCreateProactiveRule defaults to every day unless guard rules are provided", () => {
  const everyday = validateCreateProactiveRule({
    name: "Every day",
    triggerType: "periodic",
    actionType: "run_agent",
  });
  expect(everyday.ok).toBe(true);
  if (!everyday.ok) return;
  expect(everyday.value.condition.guard).toBeUndefined();

  const marketGuarded = validateCreateProactiveRule({
    name: "Market session",
    triggerType: "periodic",
    actionType: "run_agent",
    condition: {
      guard: {
        rules: [{
          type: "market_session",
          market: "XNAS",
        }],
      },
    },
  });
  expect(marketGuarded.ok).toBe(true);
  if (!marketGuarded.ok) return;
  expect(marketGuarded.value.condition.guard).toEqual({
    mode: "all",
    rules: [{
      type: "market_session",
      market: "XNAS",
      phase: "regular",
    }],
  });
});

test("validateCreateProactiveRule accepts non-market guard rules", () => {
  const result = validateCreateProactiveRule({
    name: "Weekday campaign",
    triggerType: "periodic",
    actionType: "run_agent",
    condition: {
      guard: {
        mode: "all",
        rules: [
          { type: "weekday", timezone: "Europe/Oslo", days: ["Mon", "Tue"] },
          { type: "date_range", startsAt: "2026-05-24T00:00:00Z" },
        ],
      },
    },
  });

  expect(result.ok).toBe(true);
});

test("validateUpdateProactiveRule rejects invalid active hours and channels", () => {
  const result = validateUpdateProactiveRule({
    activeHours: { start: 24 },
    notificationChannels: ["telegram", "sms"],
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.details.join("\n")).toMatch(/activeHours\.start/);
  expect(result.details.join("\n")).toMatch(/notificationChannels\.1/);
});

test("validateCreateProactiveRule rejects invalid jitter ranges", () => {
  const result = validateCreateProactiveRule({
    name: "Jittered rule",
    triggerType: "periodic",
    actionType: "run_agent",
    condition: {
      scheduleMode: "jittered",
      jitterMinMinutes: 120,
      jitterMaxMinutes: 30,
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.details.join("\n")).toMatch(/jitterMaxMinutes/);
});

test("validateCreateProactiveRule rejects malformed date range guards", () => {
  const result = validateCreateProactiveRule({
    name: "Bad campaign",
    triggerType: "periodic",
    actionType: "run_agent",
    condition: {
      guard: {
        rules: [{ type: "date_range", startsAt: "eventually" }],
      },
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.details.join("\n")).toMatch(/startsAt/);
});

test("parseStoredProactiveRule falls back safely for malformed stored JSON", () => {
  const parsed = parseStoredProactiveRule(makeRule({
    triggerType: "mystery",
    actionType: "summon",
    condition: "{",
    actionConfig: "{",
    activeHours: "{",
    notificationChannels: "{",
  }));

  expect(parsed.triggerType).toBe("periodic");
  expect(parsed.actionType).toBe("run_agent");
  expect(parsed.condition).toEqual({});
  expect(parsed.actionConfig).toEqual({});
  expect(parsed.activeHours).toEqual({});
  expect(parsed.notificationChannels).toEqual(["telegram"]);
});

test("a rule can notify nowhere and keep its result in its conversation", () => {
  const result = validateCreateProactiveRule({
    name: "Quiet job",
    triggerType: "periodic",
    actionType: "run_agent",
    actionConfig: { prompt: "work" },
    notificationChannels: [],
  });
  expect(result.ok && result.value.notificationChannels).toEqual([]);
  expect(parseStoredNotificationChannels(makeRule({ notificationChannels: "[]" }))).toEqual([]);
});

test("stored parser keeps valid active hours and notification channels", () => {
  const rule = makeRule({
    activeHours: JSON.stringify({ start: 8, end: 17, timezone: "Europe/Oslo" }),
    notificationChannels: JSON.stringify(["telegram", "discord"]),
  });

  expect(parseStoredActiveHours(rule)).toEqual({ start: 8, end: 17, timezone: "Europe/Oslo" });
  expect(parseStoredNotificationChannels(rule)).toEqual(["telegram", "discord"]);
});
