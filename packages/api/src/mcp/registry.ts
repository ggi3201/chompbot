import { MCP_TOOLS, type McpToolDefinition } from "./tool-definitions.js";
import { toolHandlers, type McpToolResult, type ToolHandler } from "./tool-handlers.js";

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

export interface McpToolRegistryEntry extends McpToolDefinition {
  handler: ToolHandler;
}

export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: McpToolDefinition["inputSchema"];
  };
}

function createRegistry(): McpToolRegistryEntry[] {
  const seen = new Set<string>();
  return MCP_TOOLS.map((definition) => {
    if (seen.has(definition.name)) {
      throw new Error(`Duplicate MCP tool definition: ${definition.name}`);
    }
    seen.add(definition.name);

    const handler = toolHandlers[definition.name];
    if (!handler) {
      throw new Error(`No handler registered for MCP tool: ${definition.name}`);
    }

    return { ...definition, handler };
  });
}

export const MCP_TOOL_REGISTRY = createRegistry();

const registryByName = new Map(MCP_TOOL_REGISTRY.map((entry) => [entry.name, entry]));

/** Strip chomp_ prefix and normalize tool names. */
export function normalizeToolName(name: string): string {
  // chomp_reply -> reply, chomp_ask_user -> ask_user, chomp_save_memory -> save_memory, etc.
  if (name.startsWith("chomp_")) return name.slice(6);
  return name;
}

export function getMcpTool(name: string): McpToolRegistryEntry | undefined {
  return registryByName.get(normalizeToolName(name));
}

export function listMcpTools(): Omit<McpToolDefinition, "requiresSession">[] {
  return MCP_TOOL_REGISTRY.map(({ handler: _handler, requiresSession: _requiresSession, ...definition }) => definition);
}

export async function callMcpTool(
  rawName: string,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<McpToolResult> {
  const entry = getMcpTool(rawName);
  if (!entry) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${rawName}` }],
      isError: true,
    };
  }

  if (entry.requiresSession && !sessionId) {
    return {
      content: [{ type: "text", text: "Missing X-Chomp-Session-Id header (required for this tool)" }],
      isError: true,
    };
  }

  try {
    return await entry.handler(args, sessionId);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Error: ${errorMsg}` }],
      isError: true,
    };
  }
}

export function toOpenAiTool(definition: McpToolDefinition): OpenAiToolDefinition {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  };
}

export function openAiToolsFor(names: readonly string[]): OpenAiToolDefinition[] {
  return names.map((name) => {
    const entry = getMcpTool(name);
    if (!entry) throw new Error(`Cannot expose unknown MCP tool to tool-agent: ${name}`);
    return toOpenAiTool(entry);
  });
}
