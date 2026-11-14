import type { EntitySchema } from "./index.js";

export const skillSchema: EntitySchema = {
  name: "skills",
  title: "Skill",
  description:
    "A reusable prompt template that agents can invoke. Contains markdown instructions " +
    "that define specialized behavior (e.g. code review, writing, data analysis).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name, e.g. 'code-review'" },
      description: { type: "string", description: "One-line description of what this skill does" },
      content: { type: "string", description: "Full markdown prompt content with instructions for the agent" },
    },
    required: ["name", "content"],
  },
  examples: [
    {
      name: "code-review",
      description: "Reviews code for bugs, style, and best practices",
      content: "You are a code reviewer. Analyze the provided code for:\n- Bugs and logic errors\n- Style and consistency\n- Performance issues\n- Security vulnerabilities\n\nProvide specific, actionable feedback with line references.",
    },
  ],
};
