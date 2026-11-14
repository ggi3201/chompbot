import type { EntitySchema } from "./index.js";

export const memorySchema: EntitySchema = {
  name: "memories",
  title: "Memory",
  description: "A piece of long-term knowledge stored for agents to recall. Categorized by type.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The memory content — a fact, preference, or instruction" },
      category: {
        type: "string",
        enum: ["preferences", "facts", "project-context", "instructions"],
        description: "Memory category",
      },
    },
    required: ["content", "category"],
  },
  examples: [
    { content: "User prefers concise responses without emojis.", category: "preferences" },
    { content: "The production database is PostgreSQL on port 5432.", category: "facts" },
  ],
};
