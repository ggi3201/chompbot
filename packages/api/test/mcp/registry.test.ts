import { test, expect } from "vitest";
import {
  MCP_TOOL_REGISTRY,
  getMcpTool,
  listMcpTools,
  normalizeToolName,
  toOpenAiTool,
  openAiToolsFor,
} from "../../src/mcp/registry.js";

test("normalizeToolName strips chomp_ prefix", () => {
  expect(normalizeToolName("chomp_reply")).toBe("reply");
  expect(normalizeToolName("chomp_save_memory")).toBe("save_memory");
});

test("normalizeToolName leaves unprefixed names alone", () => {
  expect(normalizeToolName("reply")).toBe("reply");
  expect(normalizeToolName("recall_memories")).toBe("recall_memories");
});

test("registry composes every definition with a handler", () => {
  expect(MCP_TOOL_REGISTRY.length).toBeGreaterThan(0);
  for (const entry of MCP_TOOL_REGISTRY) {
    expect(entry.name, `${entry.name} entry`).toBeTruthy();
    expect(entry.handler, `${entry.name} handler`).toBeTypeOf("function");
  }
});

test("getMcpTool resolves both prefixed and bare names", () => {
  const direct = getMcpTool("reply");
  const prefixed = getMcpTool("chomp_reply");
  expect(direct).toBeDefined();
  expect(prefixed).toBeDefined();
  expect(direct?.name).toBe("reply");
  expect(prefixed?.name).toBe("reply");
});

test("getMcpTool returns undefined for unknown tools", () => {
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

test("toOpenAiTool produces a valid OpenAI tool definition shape", () => {
  const reply = MCP_TOOL_REGISTRY.find((t) => t.name === "reply");
  expect(reply).toBeDefined();
  const projection = toOpenAiTool(reply!);
  expect(projection.type).toBe("function");
  expect(projection.function.name).toBe("reply");
  expect(projection.function.description).toBe(reply!.description);
  expect(projection.function.parameters).toBe(reply!.inputSchema);
});

test("openAiToolsFor resolves a list of names to OpenAI tool projections", () => {
  const projections = openAiToolsFor(["reply", "ask_user"]);
  expect(projections).toHaveLength(2);
  expect(projections.map((p) => p.function.name)).toEqual(["reply", "ask_user"]);
});

test("openAiToolsFor throws for unknown tools rather than silently dropping them", () => {
  expect(() => openAiToolsFor(["reply", "totally_fake_tool"])).toThrow(/totally_fake_tool/);
});
