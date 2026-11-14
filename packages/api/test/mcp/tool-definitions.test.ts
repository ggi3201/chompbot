import { test, expect } from "vitest";
import { MCP_TOOLS } from "../../src/mcp/tool-definitions.js";

test("every MCP tool has a unique snake_case name (no chomp_ prefix at the source)", () => {
  const names = MCP_TOOLS.map((t) => t.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  expect(duplicates).toEqual([]);
  for (const name of names) {
    expect(name, `${name} should be snake_case without chomp_ prefix`).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(name.startsWith("chomp_")).toBe(false);
  }
});

test("every MCP tool has a usable description and input schema, and its required fields exist in its properties", () => {
  for (const tool of MCP_TOOLS) {
    expect(tool.description, `${tool.name} description`).toBeTruthy();
    expect(tool.inputSchema, `${tool.name} schema`).toBeTruthy();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toBeTypeOf("object");
    for (const required of tool.inputSchema.required ?? []) {
      expect(
        tool.inputSchema.properties[required],
        `${tool.name}.${required} is marked required but missing from properties`,
      ).toBeTruthy();
    }
  }
});
