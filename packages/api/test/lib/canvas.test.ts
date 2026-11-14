import { test, expect } from "vitest";
import { stripCanvasBlocks } from "../../src/lib/canvas.js";

test("stripCanvasBlocks leaves canvas-free text untouched", () => {
  const text = "hello world\n\nno fenced canvas here";
  expect(stripCanvasBlocks(text)).toBe(text);
});

test("stripCanvasBlocks removes a single canvas block and preserves surrounding text", () => {
  const input = "before\n\n:::canvas\n{\"type\":\"info-card\",\"title\":\"x\",\"value\":\"1\"}\n:::\n\nafter";
  const out = stripCanvasBlocks(input);
  expect(out).toContain("before");
  expect(out).toContain("after");
  expect(out).not.toContain(":::canvas");
  expect(out).not.toContain("info-card");
});

test("stripCanvasBlocks removes multiple canvas blocks", () => {
  const input = `:::canvas\n{"type":"info-card","title":"a","value":"1"}\n:::\n\nmiddle\n\n:::canvas\n{"type":"info-card","title":"b","value":"2"}\n:::`;
  const out = stripCanvasBlocks(input);
  expect(out).toBe("middle");
});

test("stripCanvasBlocks collapses 3+ blank lines left behind after stripping", () => {
  // Stripping a canvas block can leave runs of blank lines between adjacent
  // text — the function collapses those down to a single blank-line gap.
  const input = `a\n\n:::canvas\n{"type":"info-card","title":"x","value":"1"}\n:::\n\nb`;
  expect(stripCanvasBlocks(input)).toBe("a\n\nb");
});

test("stripCanvasBlocks short-circuits when ':::canvas' is absent (no regex churn)", () => {
  const input = "plain text with    lots   of    whitespace";
  expect(stripCanvasBlocks(input)).toBe(input);
});

test("stripCanvasBlocks does not strip text that merely mentions ':::canvas' inline", () => {
  // Without a newline after the marker, the regex won't match — important so we
  // don't nuke prose that talks about the canvas system.
  const input = "the syntax is :::canvas (mentioned inline)";
  expect(stripCanvasBlocks(input)).toBe(input);
});
