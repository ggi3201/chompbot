import { test, expect } from "vitest";
import { extractJson } from "../../src/lib/extract-json.js";

test("returns trimmed raw string when no fence is present", () => {
  expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
});

test("strips ```json fence with a language tag", () => {
  const raw = '```json\n{"hello":"world"}\n```';
  expect(extractJson(raw)).toBe('{"hello":"world"}');
});

test("strips a bare ``` fence (no language tag)", () => {
  const raw = '```\n{"hello":"world"}\n```';
  expect(extractJson(raw)).toBe('{"hello":"world"}');
});

test("ignores prose before and after the fenced block", () => {
  const raw = "Sure, here's the JSON:\n```json\n{\"ok\":true}\n```\nLet me know if you need more.";
  expect(extractJson(raw)).toBe('{"ok":true}');
});

test("handles multi-line JSON inside the fence", () => {
  const raw = "```json\n{\n  \"a\": 1,\n  \"b\": [1,2,3]\n}\n```";
  expect(extractJson(raw)).toBe('{\n  "a": 1,\n  "b": [1,2,3]\n}');
});

test("handles fence with no trailing newline before closing ```", () => {
  const raw = '```json\n{"a":1}```';
  expect(extractJson(raw)).toBe('{"a":1}');
});

test("returns first fenced block when several are present", () => {
  const raw = '```json\n{"first":1}\n```\n\n```json\n{"second":2}\n```';
  expect(extractJson(raw)).toBe('{"first":1}');
});

test("plain JSON without fences is returned unchanged (after trim)", () => {
  expect(extractJson('{"k":"v"}')).toBe('{"k":"v"}');
});
