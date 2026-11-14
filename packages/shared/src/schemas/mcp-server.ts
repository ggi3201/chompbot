import type { EntitySchema } from "./index.js";

export const mcpServerSchema: EntitySchema = {
  name: "mcp-servers",
  title: "MCP Server",
  description:
    "A Model Context Protocol server that provides tools to agents. " +
    "Can be stdio (local command), HTTP, or SSE transport.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Server name" },
      description: { type: "string", description: "What tools this server provides" },
      config: {
        type: "object",
        description: "Transport configuration",
        properties: {
          type: { type: "string", enum: ["stdio", "http", "sse"], description: "Transport type" },
          command: { type: "string", description: "Command to run (stdio type), e.g. 'npx'" },
          args: { type: "array", items: { type: "string" }, description: "Command arguments (stdio type)" },
          url: { type: "string", description: "Server URL (http/sse type)" },
          env: { type: "object", description: "Environment variables to set" },
        },
        required: ["type"],
      },
    },
    required: ["name", "config"],
  },
  examples: [
    {
      name: "filesystem",
      description: "Read and write files on the local filesystem",
      config: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    },
  ],
};
