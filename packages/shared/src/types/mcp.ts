export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  type: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpServer {
  id: string;
  name: string;
  description: string;
  config: McpServerConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NewMcpServer = Omit<McpServer, "id" | "createdAt" | "updatedAt">;
