import { test, expect, describe } from "vitest";
import {
  evaluateCondition,
  evaluateConditions,
  getField,
  type FieldCondition,
} from "../../src/lib/event-conditions.js";

// ── getField ───────────────────────────────────────────────────────

describe("getField", () => {
  test("returns top-level fields", () => {
    expect(getField({ type: "x" }, "type")).toBe("x");
  });

  test("drills into nested objects via dot path", () => {
    expect(getField({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });

  test("returns undefined for missing intermediate keys", () => {
    expect(getField({ a: {} }, "a.b.c")).toBeUndefined();
  });

  test("returns undefined when traversing through a non-object", () => {
    // a.b is a number — drilling further must not throw
    expect(getField({ a: { b: 5 } }, "a.b.c")).toBeUndefined();
  });

  test("treats null intermediate values as missing", () => {
    expect(getField({ a: null }, "a.b")).toBeUndefined();
  });

  test("handles a single-segment path on an empty object", () => {
    expect(getField({}, "anything")).toBeUndefined();
  });
});

// ── evaluateCondition ──────────────────────────────────────────────

describe("evaluateCondition", () => {
  test("eq matches when stringified field equals value", () => {
    expect(evaluateCondition({ status: "ok" }, { field: "status", op: "eq", value: "ok" })).toBe(true);
    expect(evaluateCondition({ status: "down" }, { field: "status", op: "eq", value: "ok" })).toBe(false);
  });

  test("eq coerces non-string field values via String(...)", () => {
    expect(evaluateCondition({ count: 3 }, { field: "count", op: "eq", value: "3" })).toBe(true);
    expect(evaluateCondition({ flag: true }, { field: "flag", op: "eq", value: "true" })).toBe(true);
  });

  test("neq inverts the eq result", () => {
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

  test("nested-path conditions work through dot notation", () => {
    const target = { payload: { repository: { full_name: "example-org/chomp" } } };
    expect(evaluateCondition(target, { field: "payload.repository.full_name", op: "contains", value: "chomp" })).toBe(true);
  });

  test("unknown op returns false (defensive)", () => {
    const condition = { field: "a", op: "wat", value: "x" } as unknown as FieldCondition;
    expect(evaluateCondition({ a: "x" }, condition)).toBe(false);
  });
});

// ── evaluateConditions ─────────────────────────────────────────────

describe("evaluateConditions", () => {
  const target = { type: "user.active", channel: "web", payload: { x: 1 } };

  test("empty conditions list always matches", () => {
    expect(evaluateConditions(target, [])).toBe(true);
    expect(evaluateConditions(null, [])).toBe(true);
  });

  test("null/undefined target with non-empty conditions still matches (permissive)", () => {
    const cs: FieldCondition[] = [{ field: "type", op: "eq", value: "anything" }];
    expect(evaluateConditions(null, cs)).toBe(true);
    expect(evaluateConditions(undefined, cs)).toBe(true);
  });

  test("AND semantics: all conditions must pass", () => {
    const cs: FieldCondition[] = [
      { field: "type", op: "eq", value: "user.active" },
      { field: "channel", op: "eq", value: "web" },
    ];
    expect(evaluateConditions(target, cs)).toBe(true);
  });

  test("AND semantics: a single failing condition fails the whole list", () => {
    const cs: FieldCondition[] = [
      { field: "type", op: "eq", value: "user.active" },
      { field: "channel", op: "eq", value: "telegram" },
    ];
    expect(evaluateConditions(target, cs)).toBe(false);
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
