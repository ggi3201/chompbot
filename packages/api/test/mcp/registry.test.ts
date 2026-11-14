import { test, expect } from "vitest";
import {
  MCP_TOOL_REGISTRY,
  getMcpTool,
  listMcpTools,
  normalizeToolName,
  toOpenAiTool,
  openAiToolsFor,
} from "../../src/mcp/registry.js";

test("normalizeToolName strips the chomp_ prefix and leaves unprefixed names alone", () => {
  expect(normalizeToolName("chomp_reply")).toBe("reply");
  expect(normalizeToolName("chomp_save_memory")).toBe("save_memory");
  expect(normalizeToolName("reply")).toBe("reply");
  expect(normalizeToolName("recall_memories")).toBe("recall_memories");
});

test("getMcpTool resolves both prefixed and bare names, and nothing for unknown tools", () => {
  expect(getMcpTool("reply")?.name).toBe("reply");
  expect(getMcpTool("chomp_reply")?.name).toBe("reply");
  expect(getMcpTool("definitely_not_a_real_tool")).toBeUndefined();
});

test("listMcpTools strips internal handler and requiresSession fields", () => {
  const tools = listMcpTools();
  expect(tools.length).toBe(MCP_TOOL_REGISTRY.length);
  for (const tool of tools) {
    expect(tool).not.toHaveProperty("handler");
    expect(tool).not.toHaveProperty("requiresSession");
    expect(tool.name).toBeTruthy();
    expect(tool.inputSchema).toBeTruthy();
  }
});

test("openAiToolsFor resolves a list of names to OpenAI tool projections", () => {
  const reply = MCP_TOOL_REGISTRY.find((t) => t.name === "reply")!;
  expect(toOpenAiTool(reply)).toEqual({ type: "function", function: { name: "reply", description: reply.description, parameters: reply.inputSchema } });
  const projections = openAiToolsFor(["reply", "ask_user"]);
  expect(projections.map((p) => p.function.name)).toEqual(["reply", "ask_user"]);
});

test("openAiToolsFor throws for unknown tools rather than silently dropping them", () => {
  expect(() => openAiToolsFor(["reply", "totally_fake_tool"])).toThrow(/totally_fake_tool/);
});
