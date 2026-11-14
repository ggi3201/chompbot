import { describe, expect, it } from "vitest";
import { diffComment, quoteBlock, stepPrompt } from "../../src/lib/prompt-history";

const sent = ["first", "second", "third"];
const edges = { atStart: true, atEnd: true };

describe("stepPrompt", () => {
  it("recalls the newest prompt from an empty composer, then steps back and forth", () => {
    expect(stepPrompt(sent, "", "up", edges)).toBe("third");
    expect(stepPrompt(sent, "third", "up", edges)).toBe("second");
    expect(stepPrompt(sent, "first", "up", edges)).toBeNull();
    expect(stepPrompt(sent, "second", "down", edges)).toBe("third");
    expect(stepPrompt(sent, "third", "down", edges)).toBe("");
  });

  it("leaves typed text and an empty history alone", () => {
    expect(stepPrompt(sent, "half typed", "up", edges)).toBeNull();
    expect(stepPrompt(sent, "", "down", edges)).toBeNull();
    expect(stepPrompt([], "", "up", edges)).toBeNull();
  });

  it("lets the caret move inside a multi-line prompt until it reaches the edge", () => {
    const lines = ["one", "two\nlines"];
    expect(stepPrompt(lines, "two\nlines", "up", { atStart: false, atEnd: true })).toBeNull();
    expect(stepPrompt(lines, "two\nlines", "up", { atStart: true, atEnd: false })).toBe("one");
    expect(stepPrompt(lines, "two\nlines", "down", { atStart: true, atEnd: false })).toBeNull();
  });
});

describe("quoteBlock", () => {
  it("quotes every line and leaves room to answer", () => {
    expect(quoteBlock("  a\nb  ")).toBe("> a\n> b\n\n");
  });
});

describe("diffComment", () => {
  it("points at the new line of an addition, names a removed line by its old number", () => {
    expect(diffComment("src/a.ts", { kind: "add", text: "  const x = 1;", newLine: 42 }, " rename x \n")).toBe("`src/a.ts:42`\n> const x = 1;\n\nrename x\n");
    expect(diffComment("src/a.ts", { kind: "del", text: "gone()", oldLine: 7 }, "why?")).toBe("`src/a.ts`, removed line 7\n> gone()\n\nwhy?\n");
  });
});
