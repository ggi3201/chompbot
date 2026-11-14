import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { souls } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  const result = db.select().from(souls).all();
  res.json(result);
});

router.get("/:id", (req: Request, res: Response) => {
  const result = db.select().from(souls).where(eq(souls.id, req.params.id as string)).get();
  if (!result) {
    res.status(404).json({ error: "Soul not found" });
    return;
  }
  res.json(result);
});

router.post("/", (req: Request, res: Response) => {
  const { name, description, content, imageUrl, color, isDefault } = req.body;
  const id = randomUUID();
  const now = new Date().toISOString();

  // If this soul is being set as default, clear any existing default
  if (isDefault) {
    db.update(souls).set({ isDefault: false }).run();
  }

  db.insert(souls).values({
    id,
    name: name ?? "Untitled Soul",
    description: description ?? "",
    content: content ?? "",
    imageUrl: imageUrl ?? null,
    color: color ?? "violet",
    isDefault: isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = db.select().from(souls).where(eq(souls.id, id)).get()!;
  res.status(201).json(created);
});

router.put("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(souls).where(eq(souls.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Soul not found" });
    return;
  }

  const { name, description, content, imageUrl, color, isDefault } = req.body;

  // If setting as default, clear existing default first
  if (isDefault) {
    db.update(souls).set({ isDefault: false }).run();
  }

  db.update(souls).set({
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(content !== undefined && { content }),
    ...(imageUrl !== undefined && { imageUrl }),
    ...(color !== undefined && { color }),
    ...(isDefault !== undefined && { isDefault }),
    updatedAt: new Date().toISOString(),
  }).where(eq(souls.id, req.params.id as string)).run();

  const updated = db.select().from(souls).where(eq(souls.id, req.params.id as string)).get()!;
  res.json(updated);
});

router.delete("/:id", (req: Request, res: Response) => {
  const existing = db.select().from(souls).where(eq(souls.id, req.params.id as string)).get();
  if (!existing) {
    res.status(404).json({ error: "Soul not found" });
    return;
  }
  db.delete(souls).where(eq(souls.id, req.params.id as string)).run();
  res.status(204).send();
});

export default router;
