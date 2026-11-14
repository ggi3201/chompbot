import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { proactiveRules, proactiveRuleRuns } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  parseStoredProactiveRule,
  validateCreateProactiveRule,
  validateUpdateProactiveRule,
} from "../proactive/rule-model.js";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(proactiveRules).all();
  res.json(result.map(parseStoredProactiveRule));
});

router.get("/runs", (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 100;
  const runs = db
    .select({
      id: proactiveRuleRuns.id,
      ruleId: proactiveRuleRuns.ruleId,
      ruleName: proactiveRules.name,
      triggeredAt: proactiveRuleRuns.triggeredAt,
      triggerType: proactiveRuleRuns.triggerType,
      outcome: proactiveRuleRuns.outcome,
      reason: proactiveRuleRuns.reason,
      outputPreview: proactiveRuleRuns.outputPreview,
      durationMs: proactiveRuleRuns.durationMs,
      errorMessage: proactiveRuleRuns.errorMessage,
    })
    .from(proactiveRuleRuns)
    .leftJoin(proactiveRules, eq(proactiveRuleRuns.ruleId, proactiveRules.id))
    .orderBy(desc(proactiveRuleRuns.triggeredAt))
    .limit(limit)
    .all();
  res.json(runs);
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(proactiveRules).where(eq(proactiveRules.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "Proactive rule not found" });
    return;
  }
  res.json(parseStoredProactiveRule(result));
});

router.post("/", (req: Request, res: Response) => {
  const validated = validateCreateProactiveRule(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error, details: validated.details });
    return;
  }
  const { name, triggerType, condition, actionType, actionConfig, enabled, cooldownMinutes, activeHours, priority, runAt, notificationChannels } = validated.value;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(proactiveRules).values({
    id,
    name,
    triggerType,
    condition: JSON.stringify(condition),
    actionType,
    actionConfig: JSON.stringify(actionConfig),
    enabled,
    cooldownMinutes,
    activeHours: JSON.stringify(activeHours),
    priority,
    notificationChannels: JSON.stringify(notificationChannels),
    runAt,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(proactiveRules).where(eq(proactiveRules.id, id)).get()!;
  res.status(201).json(parseStoredProactiveRule(created));
});

router.put("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(proactiveRules).where(eq(proactiveRules.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Proactive rule not found" });
    return;
  }

  const validated = validateUpdateProactiveRule(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error, details: validated.details });
    return;
  }
  const { name, triggerType, condition, actionType, actionConfig, enabled, cooldownMinutes, activeHours, priority, runAt, notificationChannels } = validated.value;

  db.update(proactiveRules).set({
    ...(name !== undefined && { name }),
    ...(triggerType !== undefined && { triggerType }),
    ...(condition !== undefined && { condition: JSON.stringify(condition) }),
    ...(actionType !== undefined && { actionType }),
    ...(actionConfig !== undefined && { actionConfig: JSON.stringify(actionConfig) }),
    ...(enabled !== undefined && { enabled }),
    ...(cooldownMinutes !== undefined && { cooldownMinutes }),
    ...(activeHours !== undefined && { activeHours: JSON.stringify(activeHours) }),
    ...(priority !== undefined && { priority }),
    ...(notificationChannels !== undefined && { notificationChannels: JSON.stringify(notificationChannels) }),
    ...(runAt !== undefined && { runAt }),
    updatedAt: new Date().toISOString(),
  }).where(eq(proactiveRules.id, req.params.id as string)).run();

  const updated = db.select().from(proactiveRules).where(eq(proactiveRules.id, req.params.id as string)).get()!;
  res.json(parseStoredProactiveRule(updated));
});

router.post("/:id/trigger", async (req: Request, res: Response) => {
  const { triggerRule } = await import("../proactive/engine.js");
  const result = await triggerRule(req.params.id as string);
  if (!result.ok) {
    res.status(result.error === "Rule not found" ? 404 : 500).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

router.get("/:id/runs", (req: Request, res: Response) => {
  const existing = db.select().from(proactiveRules).where(eq(proactiveRules.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Proactive rule not found" });
    return;
  }
  const runs = db
    .select()
    .from(proactiveRuleRuns)
    .where(eq(proactiveRuleRuns.ruleId, req.params.id as string))
    .orderBy(desc(proactiveRuleRuns.triggeredAt))
    .limit(50)
    .all();
  res.json(runs);
});

router.post("/:id/dry-run", async (req: Request, res: Response) => {
  const { dryRunRule } = await import("../proactive/engine.js");
  const result = await dryRunRule(req.params.id as string);
  if (!result.ok) {
    res.status(result.error === "Rule not found" ? 404 : 500).json({ error: result.error });
    return;
  }
  res.json({ ok: true, preview: result.preview });
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(proactiveRules).where(eq(proactiveRules.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Proactive rule not found" });
    return;
  }
  db.delete(proactiveRules).where(eq(proactiveRules.id, req.params.id as string)).run();
  res.status(204).send();
});

export default router;
