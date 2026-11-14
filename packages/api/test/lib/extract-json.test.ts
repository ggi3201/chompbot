import { test, expect } from "vitest";
import { extractJson } from "../../src/lib/extract-json.js";

test("without a fence the raw string is returned, trimmed", () => {
  expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  expect(extractJson('{"k":"v"}')).toBe('{"k":"v"}');
});

test("strips a fence with or without a language tag, multi-line or with no newline before the closing ```", () => {
  expect(extractJson('```json\n{"hello":"world"}\n```')).toBe('{"hello":"world"}');
  expect(extractJson('```\n{"hello":"world"}\n```')).toBe('{"hello":"world"}');
  expect(extractJson("```json\n{\n  \"a\": 1,\n  \"b\": [1,2,3]\n}\n```")).toBe('{\n  "a": 1,\n  "b": [1,2,3]\n}');
  expect(extractJson('```json\n{"a":1}```')).toBe('{"a":1}');
});

test("ignores prose around the fenced block, and returns the first of several", () => {
  expect(extractJson("Sure, here's the JSON:\n```json\n{\"ok\":true}\n```\nLet me know if you need more.")).toBe('{"ok":true}');
  expect(extractJson('```json\n{"first":1}\n```\n\n```json\n{"second":2}\n```')).toBe('{"first":1}');
});
