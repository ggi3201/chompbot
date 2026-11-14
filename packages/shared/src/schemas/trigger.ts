import type { EntitySchema } from "./index.js";

export const triggerSchema: EntitySchema = {
  name: "triggers",
  title: "Event Trigger",
  description:
    "Fires an action when a specific system event occurs and optional field conditions match. " +
    "Actions: send a notification, run a schedule, or delegate to an agent.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short descriptive name" },
      description: { type: "string", description: "What this trigger does" },
      eventType: {
        type: "string",
        enum: [
          "chat.message", "agent.started", "agent.completed", "agent.failed",
          "schedule.completed", "schedule.failed", "service.health.changed",
          "user.active", "user.idle", "memory.saved", "webhook.received", "location.changed", "system.startup",
        ],
        description: "The system event that fires this trigger",
      },
      condition: {
        type: "array",
        description: "Field-level conditions that must all match on the event payload. Empty array = always match.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Dot-path on event payload" },
            op: { type: "string", enum: ["eq", "neq", "contains"] },
            value: { type: "string" },
          },
          required: ["field", "op", "value"],
        },
      },
      action: {
        type: "object",
        description: "What to do when triggered",
        properties: {
          type: { type: "string", enum: ["notify", "run-schedule", "delegate"], description: "Action type" },
          title: { type: "string", description: "Notification title (for notify)" },
          body: { type: "string", description: "Notification body (for notify)" },
          prompt: { type: "string", description: "Instructions for the agent (for delegate)" },
          deliver: { type: "boolean", description: "Send the agent's answer to the user's notification channels (for delegate). Without it the answer stays in the trigger's conversation." },
        },
        required: ["type"],
      },
      cooldownSeconds: { type: "integer", description: "Minimum seconds between firings. Default 60.", default: 60 },
      once: { type: "boolean", description: "Delete the trigger after it fires once. Default false.", default: false },
    },
    required: ["name", "eventType", "action"],
  },
  dynamicContext: ["eventTypes"],
  examples: [
    {
      name: "Notify on agent failure",
      description: "Send a notification when any agent fails",
      eventType: "agent.failed",
      condition: [],
      action: { type: "notify", title: "Agent Failed", body: "An agent encountered an error." },
      cooldownSeconds: 120,
    },
  ],
};
