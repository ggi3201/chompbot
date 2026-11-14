import { test, expect } from "vitest";
import { stripCanvasBlocks } from "../../src/lib/canvas.js";

test("stripCanvasBlocks leaves text without a canvas block untouched, including inline mentions", () => {
  const text = "hello world\n\nno fenced canvas here";
  expect(stripCanvasBlocks(text)).toBe(text);
  // Without a newline after the marker, the regex won't match — important so we
  // don't nuke prose that talks about the canvas system.
  const inline = "the syntax is :::canvas (mentioned inline)";
  expect(stripCanvasBlocks(inline)).toBe(inline);
});

test("stripCanvasBlocks removes multiple canvas blocks", () => {
  const input = `:::canvas\n{"type":"info-card","title":"a","value":"1"}\n:::\n\nmiddle\n\n:::canvas\n{"type":"info-card","title":"b","value":"2"}\n:::`;
  const out = stripCanvasBlocks(input);
  expect(out).toBe("middle");
});

test("stripCanvasBlocks removes a block, keeps surrounding text and collapses 3+ blank lines left behind", () => {
  // Stripping a canvas block can leave runs of blank lines between adjacent
  // text — the function collapses those down to a single blank-line gap.
  const input = `a\n\n:::canvas\n{"type":"info-card","title":"x","value":"1"}\n:::\n\nb`;
  expect(stripCanvasBlocks(input)).toBe("a\n\nb");
});
