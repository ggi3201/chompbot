import type { EntitySchema } from "./index.js";

export const pluginSchema: EntitySchema = {
  name: "plugins",
  title: "Plugin",
  description: "An external plugin that extends system capabilities. Loaded from a source URL or path.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Plugin name" },
      version: { type: "string", description: "Semantic version, e.g. '1.0.0'", default: "0.0.0" },
      description: { type: "string", description: "What this plugin does" },
      source: { type: "string", description: "URL or local path to the plugin" },
      config: { type: "object", description: "Plugin-specific configuration" },
    },
    required: ["name"],
  },
};
