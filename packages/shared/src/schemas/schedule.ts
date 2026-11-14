import type { EntitySchema } from "./index.js";

export const scheduleSchema: EntitySchema = {
  name: "schedules",
  title: "Schedule",
  description:
    "A recurring task on a cron schedule. Each run dispatches to an agent (or the default) " +
    "with an optional prompt. Use for daily briefs, periodic health checks, data syncs, etc.",
  inputSchema: {
    type: "object",
    properties: {
      naturalLanguage: { type: "string", description: "Human-readable description, e.g. 'Every morning at 8am'" },
      cronExpression: { type: "string", description: "Standard 5-field cron, e.g. '0 8 * * *'" },
      context: {
        type: "object",
        description: "Runtime context passed to the agent",
        properties: {
          prompt: { type: "string", description: "Instructions for the agent on each run" },
          target: { type: "object", description: "Who runs it: {soulId?, provider?, model?, effort?}. soulId MUST come from availableAgents. Omit for the default." },
          services: { type: "array", items: { type: "string" }, description: "Service names to include in context" },
        },
      },
    },
    required: ["naturalLanguage", "cronExpression"],
  },
  dynamicContext: ["agents", "mcpServers"],
  examples: [
    {
      naturalLanguage: "Every morning at 8am",
      cronExpression: "0 8 * * *",
      context: { prompt: "Give me a morning summary of system health and recent activity." },
    },
    {
      naturalLanguage: "Every 6 hours",
      cronExpression: "0 */6 * * *",
      context: { prompt: "Check all connected services and report any issues." },
    },
  ],
};
