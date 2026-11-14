import { Router, type Request, type Response } from "express";
import { entitySchemas, type EntitySchema } from "@chomp/shared";
import { backgroundCompletion } from "../lib/background-model.js";
import { db } from "../db/index.js";
import { mcpServers, souls } from "../db/schema.js";
import { extractJson } from "../lib/extract-json.js";

const router: ReturnType<typeof Router> = Router();

function resolveDynamicContext(needs: string[]): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const need of needs) {
    switch (need) {
      case "agents": {
        ctx.availableAgents = db.select().from(souls).all().map((s) => ({ soulId: s.id, name: s.name, description: s.description }));
        ctx.availableProviders = ["claude", "codex"];
        break;
      }
      case "mcpServers": {
        const rows = db.select().from(mcpServers).all().filter((s) => s.enabled);
        ctx.availableMcpServers = rows.map((s) => ({ name: s.name, description: s.description, healthStatus: s.healthStatus }));
        break;
      }
      case "eventTypes":
        ctx.eventTypes = [
          "chat.message", "agent.started", "agent.completed", "agent.failed",
          "schedule.completed", "schedule.failed", "service.health.changed",
          "user.active", "user.idle", "memory.saved", "webhook.received", "location.changed", "system.startup",
        ];
        break;
    }
  }
  return ctx;
}

function buildSystemPrompt(schema: EntitySchema, dynamicCtx: Record<string, unknown>): string {
  let prompt = `You are a configuration generator for Chomp, a personal AI assistant system.

Generate a valid JSON object for a "${schema.title}" based on the user's description.

## What a ${schema.title} is
${schema.description}

## JSON Schema — your output MUST conform to this
${JSON.stringify(schema.inputSchema, null, 2)}
`;

  if (Object.keys(dynamicCtx).length > 0) {
    prompt += `\n## Live context — use these real values\n`;
    for (const [key, value] of Object.entries(dynamicCtx)) {
      prompt += `### ${key}\n${JSON.stringify(value, null, 2)}\n\n`;
    }
  }

  if (schema.examples?.length) {
    prompt += `\n## Examples of valid output\n`;
    for (const ex of schema.examples) {
      prompt += `\`\`\`json\n${JSON.stringify(ex, null, 2)}\n\`\`\`\n`;
    }
  }

  prompt += `\nRules:
- Return ONLY a single valid JSON object
- No markdown fences, no explanation, no commentary
- All required fields must be present
- Use real values from the context above (agent names, event types, etc.)
- Be practical and specific`;

  return prompt;
}

router.post("/:entity", async (req: Request, res: Response) => {
  const entityType = req.params.entity as string;
  const schema = entitySchemas[entityType as keyof typeof entitySchemas];

  if (!schema) {
    res.status(400).json({ error: `Unknown entity type: ${entityType}` });
    return;
  }

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const dynamicCtx = resolveDynamicContext(schema.dynamicContext ?? []);
    const systemPrompt = buildSystemPrompt(schema, dynamicCtx);
    const content = await backgroundCompletion({ system: systemPrompt, prompt });
    const cleaned = extractJson(content);
    const parsed = JSON.parse(cleaned);

    const missing = schema.inputSchema.required.filter((f: string) => parsed[f] === undefined);
    if (missing.length > 0) {
      res.status(422).json({ error: `Missing required fields: ${missing.join(", ")}`, generated: parsed });
      return;
    }

    res.json({ generated: parsed });
  } catch (err) {
    console.error(`[generate] Failed for ${entityType}:`, err instanceof Error ? err.message : err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Generation failed" });
  }
});

export default router;
