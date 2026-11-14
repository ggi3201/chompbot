import { test, expect } from "vitest";
import { MCP_TOOLS } from "../../src/mcp/tool-definitions.js";

test("MCP_TOOLS is non-empty", () => {
  expect(MCP_TOOLS.length).toBeGreaterThan(0);
});

test("every MCP tool has a unique name", () => {
  const names = MCP_TOOLS.map((t) => t.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  expect(duplicates).toEqual([]);
});

test("every MCP tool has a usable description and input schema", () => {
  for (const tool of MCP_TOOLS) {
    expect(tool.name, `tool name`).toBeTruthy();
    expect(tool.description, `${tool.name} description`).toBeTruthy();
    expect(tool.inputSchema, `${tool.name} schema`).toBeTruthy();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toBeTypeOf("object");
  }
});

test("every required field on a tool exists in its properties", () => {
  for (const tool of MCP_TOOLS) {
    if (!tool.inputSchema.required) continue;
    for (const required of tool.inputSchema.required) {
      expect(
        tool.inputSchema.properties[required],
        `${tool.name}.${required} is marked required but missing from properties`,
      ).toBeTruthy();
    }
  }
});

test("session-bound tools include reply and ask_user", () => {
  const sessionTools = MCP_TOOLS.filter((t) => t.requiresSession).map((t) => t.name);
  expect(sessionTools).toContain("reply");
  expect(sessionTools).toContain("ask_user");
});

test("MCP tool names are snake_case (no chomp_ prefix at the source)", () => {
  for (const tool of MCP_TOOLS) {
    expect(tool.name, `${tool.name} should be snake_case without chomp_ prefix`).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tool.name.startsWith("chomp_")).toBe(false);
  }
});

test("create_proactive_rule exposes notification channel selection", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "create_proactive_rule");
  expect(tool).toBeTruthy();

  const notificationChannels = tool?.inputSchema.properties.notification_channels;
  expect(notificationChannels).toMatchObject({
    type: "array",
    items: {
      type: "string",
      enum: ["telegram", "discord"],
    },
  });
});

test("create_proactive_rule exposes optional generic guard", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "create_proactive_rule");
  expect(tool).toBeTruthy();

  expect(tool?.inputSchema.properties.guard).toMatchObject({
    type: "object",
    properties: {
      mode: { type: "string", enum: ["all", "any"] },
      rules: { type: "array", items: { type: "object" } },
    },
  });
});

test("discord_post takes a single required message string", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "discord_post");
  expect(tool).toBeTruthy();
  expect(tool?.requiresSession).toBeFalsy();
  expect(tool?.inputSchema.required).toEqual(["message"]);
  expect(tool?.inputSchema.properties.message).toMatchObject({ type: "string" });
});
