import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { skills, souls } from "../db/schema.js";
import { savedTarget } from "../agents/run-target.js";
import { getClaudeModels, getCodexModels } from "../agents/runtime/models.js";
import { getUsageLimits } from "../agents/runtime/usage.js";
import type { AgentProviderModels } from "@chomp/shared";

const router: ReturnType<typeof Router> = Router();

/**
 * GET /api/chat/completions
 * Returns slash commands, skills, and agent names for chat autocomplete.
 */
router.get("/completions", (_req: Request, res: Response) => {
  // Static command list
  const commands = [
    {
      trigger: "/help",
      label: "Help",
      description: "What you can do here: keys, commands, and an example of every component",
    },
    {
      trigger: "/handoff",
      label: "Hand off",
      description: "Write a handoff and open a new chat: /handoff [model] [effort] [task]",
    },
    {
      trigger: "/reload-skills",
      label: "Reload skills",
      description: "Pick up skills added or changed on disk, in this chat",
    },
    {
      trigger: "/reload-plugins",
      label: "Reload plugins",
      description: "Pick up Claude Code plugins installed or switched on, in this chat",
    },
    {
      trigger: "/compact",
      label: "Compact",
      description: "Summarise this chat's session to free up context (Claude chats)",
    },
  ];

  // Enabled skills as /commands
  const enabledSkills = db.select().from(skills).all().filter((s) => s.enabled);
  for (const skill of enabledSkills) {
    const slug = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    commands.push({
      trigger: `/${slug}`,
      label: skill.name,
      description: skill.description || skill.name,
    });
  }

  // What @ can reach: a soul. The runtime is chosen in the composer, not by mention.
  const agentList = [
    ...db.select().from(souls).all().map((soul) => ({ name: soul.name, type: "agent", shorthands: [] as string[] })),
  ];

  res.json({ commands, agents: agentList });
});

/**
 * GET /api/chat/agent-models
 * The model picker's catalogue: each CLI provider and the models its login can
 * use with their reasoning levels.
 */
router.get("/agent-models", async (_req: Request, res: Response) => {
  const [claude, codex] = await Promise.all([getClaudeModels(), getCodexModels()]);
  const providers: AgentProviderModels[] = [claude, codex];
  res.json(providers);
});

/**
 * GET /api/chat/run-targets
 * The saved defaults, as the Settings page edits them.
 */
router.get("/run-targets", (_req: Request, res: Response) => {
  res.json({ default: savedTarget("default"), discord: savedTarget("discord"), telegram: savedTarget("telegram") });
});

/**
 * GET /api/chat/usage-limits
 * Plan usage per provider (5-hour and weekly windows), as the CLIs report it.
 */
router.get("/usage-limits", async (_req: Request, res: Response) => {
  res.json(await getUsageLimits());
});

export default router;
