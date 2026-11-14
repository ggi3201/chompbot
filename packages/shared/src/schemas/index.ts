export interface EntitySchema {
  /** URL segment, e.g. "proactive-rules" */
  name: string;
  /** Human label, e.g. "Proactive Rule" */
  title: string;
  /** What this entity is — included in the LLM system prompt */
  description: string;
  /** JSON Schema for creatable fields (omits id, timestamps, counters) */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Which live data the LLM needs to generate valid values */
  dynamicContext?: Array<"agents" | "mcpServers" | "eventTypes">;
  /** Example outputs for few-shot prompting */
  examples?: Record<string, unknown>[];
}

import { proactiveRuleSchema } from "./proactive-rule.js";
import { triggerSchema } from "./trigger.js";
import { scheduleSchema } from "./schedule.js";
import { skillSchema } from "./skill.js";
import { mcpServerSchema } from "./mcp-server.js";
import { webhookSchema } from "./webhook.js";
import { memorySchema } from "./memory.js";
import { pluginSchema } from "./plugin.js";

export const entitySchemas: Record<string, EntitySchema> = {
  "proactive-rules": proactiveRuleSchema,
  "triggers": triggerSchema,
  "schedules": scheduleSchema,
  "skills": skillSchema,
  "mcp-servers": mcpServerSchema,
  "webhooks": webhookSchema,
  "memories": memorySchema,
  "plugins": pluginSchema,
};
