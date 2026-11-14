import type { EntitySchema } from "./index.js";

export const webhookSchema: EntitySchema = {
  name: "webhooks",
  title: "Webhook",
  description: "An incoming webhook endpoint that receives external HTTP payloads and emits system events.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Webhook name" },
      description: { type: "string", description: "What sends data to this webhook" },
      eventType: { type: "string", description: "Event type emitted when payload arrives", default: "webhook.received" },
    },
    required: ["name"],
  },
  examples: [
    { name: "github-push", description: "GitHub push events", eventType: "webhook.received" },
  ],
};
