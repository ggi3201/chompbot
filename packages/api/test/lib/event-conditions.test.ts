import { test, expect, describe } from "vitest";
import {
  evaluateCondition,
  evaluateConditions,
  getField,
  type FieldCondition,
} from "../../src/lib/event-conditions.js";

// ── getField ───────────────────────────────────────────────────────

describe("getField", () => {
  test("returns top-level fields and drills into nested objects via dot path", () => {
    expect(getField({ type: "x" }, "type")).toBe("x");
    expect(getField({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });

  test("returns undefined for missing keys, null intermediates and non-object traversal", () => {
    expect(getField({ a: {} }, "a.b.c")).toBeUndefined();
    // a.b is a number — drilling further must not throw
    expect(getField({ a: { b: 5 } }, "a.b.c")).toBeUndefined();
    expect(getField({ a: null }, "a.b")).toBeUndefined();
    expect(getField({}, "anything")).toBeUndefined();
  });
});

// ── evaluateCondition ──────────────────────────────────────────────

describe("evaluateCondition", () => {
  test("eq/neq compare the stringified field value", () => {
    expect(evaluateCondition({ status: "ok" }, { field: "status", op: "eq", value: "ok" })).toBe(true);
    expect(evaluateCondition({ status: "down" }, { field: "status", op: "eq", value: "ok" })).toBe(false);
    expect(evaluateCondition({ count: 3 }, { field: "count", op: "eq", value: "3" })).toBe(true);
    expect(evaluateCondition({ flag: true }, { field: "flag", op: "eq", value: "true" })).toBe(true);
    expect(evaluateCondition({ status: "ok" }, { field: "status", op: "neq", value: "down" })).toBe(true);
    expect(evaluateCondition({ status: "ok" }, { field: "status", op: "neq", value: "ok" })).toBe(false);
  });

  test("contains: substring match against the stringified field", () => {
    expect(evaluateCondition({ msg: "hello world" }, { field: "msg", op: "contains", value: "world" })).toBe(true);
    expect(evaluateCondition({ msg: "hi" }, { field: "msg", op: "contains", value: "world" })).toBe(false);
  });

  test("missing field reads as empty string", () => {
    expect(evaluateCondition({}, { field: "missing", op: "eq", value: "" })).toBe(true);
    expect(evaluateCondition({}, { field: "missing", op: "neq", value: "x" })).toBe(true);
    expect(evaluateCondition({}, { field: "missing", op: "contains", value: "anything" })).toBe(false);
  });

  test("unknown op returns false (defensive)", () => {
    const condition = { field: "a", op: "wat", value: "x" } as unknown as FieldCondition;
    expect(evaluateCondition({ a: "x" }, condition)).toBe(false);
  });
});

// ── evaluateConditions ─────────────────────────────────────────────

describe("evaluateConditions", () => {
  const target = { type: "user.active", channel: "web", payload: { x: 1 } };

  test("empty conditions always match; null/undefined target still matches (permissive)", () => {
    expect(evaluateConditions(target, [])).toBe(true);
    expect(evaluateConditions(null, [])).toBe(true);
    const cs: FieldCondition[] = [{ field: "type", op: "eq", value: "anything" }];
    expect(evaluateConditions(null, cs)).toBe(true);
    expect(evaluateConditions(undefined, cs)).toBe(true);
  });

  test("AND semantics: all conditions must pass, one failure fails the list", () => {
    expect(evaluateConditions(target, [
      { field: "type", op: "eq", value: "user.active" },
      { field: "channel", op: "eq", value: "web" },
    ])).toBe(true);
    expect(evaluateConditions(target, [
      { field: "type", op: "eq", value: "user.active" },
      { field: "channel", op: "eq", value: "telegram" },
    ])).toBe(false);
  });

  test("works on event-shaped objects with nested payloads", () => {
    const event = {
      type: "webhook.received",
      webhookName: "github",
      payload: { action: "opened", pull_request: { user: { login: "testuser" } } },
    };
    const cs: FieldCondition[] = [
      { field: "type", op: "eq", value: "webhook.received" },
      { field: "payload.action", op: "eq", value: "opened" },
      { field: "payload.pull_request.user.login", op: "contains", value: "testuser" },
    ];
    expect(evaluateConditions(event, cs)).toBe(true);
  });
});
