import { test, expect } from "vitest";
import { parseFrontmatter } from "../../src/sync/import.js";

test.each([
  ["plain", "description: One line.\nlicense: MIT", "One line."],
  ["quoted", 'description: "One: line."\nlicense: MIT', "One: line."],
  ["folded", "description: >\n  First line,\n  second line.\nlicense: MIT", "First line, second line."],
  ["folded, stripped", "description: >-\n  First line,\n\n  second line.\nlicense: MIT", "First line, second line."],
  ["literal, last key", "description: |\n  Only line.", "Only line."],
])("reads a %s description", (_kind, yaml, expected) => {
  expect(parseFrontmatter(`---\nname: x\n${yaml}\n---\nBody`)).toMatchObject({ name: "x", description: expected, content: "Body" });
});
