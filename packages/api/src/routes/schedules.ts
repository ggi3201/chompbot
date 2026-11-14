import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { schedules } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { backgroundCompletion } from "../lib/background-model.js";

const router: ReturnType<typeof Router> = Router();

/** Ask the background model to convert natural language to a cron expression */
async function nlToCron(description: string): Promise<string> {
  const reply = await backgroundCompletion({
    system: "You are a cron expression generator. Given a natural language schedule description, respond with ONLY the cron expression (5 fields: minute hour day-of-month month day-of-week). No explanation, no markdown, just the cron expression.",
    prompt: description,
  });
  return reply.trim();
}

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(schedules).all();
  const parsed = result.map((s) => ({
    ...s,
    context: JSON.parse(s.context),
  }));
  res.json(parsed);
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(schedules).where(eq(schedules.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }
  res.json({ ...result, context: JSON.parse(result.context) });
});

router.post("/", async (req: Request, res: Response) => {
  const { naturalLanguage, cronExpression, enabled, context } = req.body;
  if (!naturalLanguage) {
    res.status(400).json({ error: "naturalLanguage is required" });
    return;
  }

  let cron = cronExpression;
  if (!cron) {
    try {
      cron = await nlToCron(naturalLanguage);
    } catch {
      res.status(500).json({ error: "Failed to convert schedule description to cron" });
      return;
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(schedules).values({
    id,
    naturalLanguage,
    cronExpression: cron,
    enabled: enabled ?? true,
    context: JSON.stringify(context ?? {}),
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(schedules).where(eq(schedules.id, id)).get()!;
  res.status(201).json({ ...created, context: JSON.parse(created.context) });
});

router.put("/:id", async (req: Request, res: Response) => {
  const existing = db.select().from(schedules).where(eq(schedules.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  const { naturalLanguage, cronExpression, enabled, context } = req.body;

  // If NL changed but no explicit cron given, re-derive it
  let cron = cronExpression;
  if (naturalLanguage && naturalLanguage !== existing.naturalLanguage && !cronExpression) {
    try {
      cron = await nlToCron(naturalLanguage);
    } catch {
      // keep existing cron if conversion fails
    }
  }

  db.update(schedules).set({
    ...(naturalLanguage !== undefined && { naturalLanguage }),
    ...(cron !== undefined && { cronExpression: cron }),
    ...(enabled !== undefined && { enabled }),
    ...(context !== undefined && { context: JSON.stringify(context) }),
    updatedAt: new Date().toISOString(),
  }).where(eq(schedules.id, req.params.id as string)).run();

  const updated = db.select().from(schedules).where(eq(schedules.id, req.params.id as string)).get()!;
  res.json({ ...updated, context: JSON.parse(updated.context) });
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(schedules).where(eq(schedules.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }
  db.delete(schedules).where(eq(schedules.id, req.params.id as string)).run();
  res.status(204).send();
});

// Trigger a schedule manually
router.post("/:id/trigger", (req: Request, res: Response) => {
  const existing = db.select().from(schedules).where(eq(schedules.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }
  // Publish trigger event via Redis (the worker listens for this)
  // For now, just mark it as needing a run
  db.update(schedules).set({
    lastRun: null, // Reset so heartbeat picks it up as "due"
    updatedAt: new Date().toISOString(),
  }).where(eq(schedules.id, req.params.id as string)).run();

  res.json({ status: "triggered", scheduleId: existing.id });
});

export default router;
