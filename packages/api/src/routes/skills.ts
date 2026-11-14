import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { skills } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { syncSkill, removeSkillFile } from "../sync/skills.js";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(skills).all();
  res.json(result);
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(skills).where(eq(skills.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  res.json(result);
});

router.post("/", (req: Request, res: Response) => {
  const { name, description, content, source, enabled } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(skills).values({
    id,
    name,
    description: description ?? "",
    content: content ?? "",
    source: source ?? "user",
    enabled: enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(skills).where(eq(skills.id, id)).get()!;
  syncSkill(created);
  res.status(201).json(created);
});

router.put("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(skills).where(eq(skills.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }

  const { name, description, content, source, enabled } = req.body;
  db.update(skills).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(content !== undefined && { content }),
    ...(source !== undefined && { source }),
    ...(enabled !== undefined && { enabled }),
    updatedAt: new Date().toISOString(),
  }).where(eq(skills.id, req.params.id as string)).run();

  const updated = db.select().from(skills).where(eq(skills.id, req.params.id as string)).get()!;
  syncSkill(updated);
  res.json(updated);
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(skills).where(eq(skills.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  db.delete(skills).where(eq(skills.id, req.params.id as string)).run();
  removeSkillFile(existing.name);
  res.status(204).send();
});

export default router;
