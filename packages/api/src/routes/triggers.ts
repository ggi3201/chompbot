import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { eventTriggers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(eventTriggers).all();
  const parsed = result.map((t) => ({
    ...t,
    condition: JSON.parse(t.condition),
    action: JSON.parse(t.action),
  }));
  res.json(parsed);
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(eventTriggers).where(eq(eventTriggers.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }
  res.json({ ...result, condition: JSON.parse(result.condition), action: JSON.parse(result.action) });
});

router.post("/", (req: Request, res: Response) => {
  const { name, description, eventType, condition, action, enabled, cooldownSeconds, once } = req.body;
  if (!name || !eventType) {
    res.status(400).json({ error: "name and eventType are required" });
    return;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(eventTriggers).values({
    id,
    name,
    description: description ?? "",
    eventType,
    condition: JSON.stringify(condition ?? []),
    action: JSON.stringify(action ?? {}),
    enabled: enabled ?? true,
    cooldownSeconds: cooldownSeconds ?? 0,
    once: once ?? false,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(eventTriggers).where(eq(eventTriggers.id, id)).get()!;
  res.status(201).json({ ...created, condition: JSON.parse(created.condition), action: JSON.parse(created.action) });
});

router.put("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(eventTriggers).where(eq(eventTriggers.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }

  const { name, description, eventType, condition, action, enabled, cooldownSeconds, once } = req.body;

  db.update(eventTriggers).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(eventType !== undefined && { eventType }),
    ...(condition !== undefined && { condition: JSON.stringify(condition) }),
    ...(action !== undefined && { action: JSON.stringify(action) }),
    ...(enabled !== undefined && { enabled }),
    ...(cooldownSeconds !== undefined && { cooldownSeconds }),
    ...(once !== undefined && { once }),
    updatedAt: new Date().toISOString(),
  }).where(eq(eventTriggers.id, req.params.id as string)).run();

  const updated = db.select().from(eventTriggers).where(eq(eventTriggers.id, req.params.id as string)).get()!;
  res.json({ ...updated, condition: JSON.parse(updated.condition), action: JSON.parse(updated.action) });
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(eventTriggers).where(eq(eventTriggers.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }
  db.delete(eventTriggers).where(eq(eventTriggers.id, req.params.id as string)).run();
  res.status(204).send();
});

export default router;
