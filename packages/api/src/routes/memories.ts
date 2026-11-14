import { Router } from "express";
import {
  saveMemory,
  recallMemories,
  getMemoryById,
  updateMemory,
  deleteMemory,
  getAllMemories,
} from "../db/memories.js";

const router: ReturnType<typeof Router> = Router();

// List all memories
router.get("/", (req, res) => {
  const { category, query, limit } = req.query;
  if (category || query) {
    const results = recallMemories({
      category: category as string | undefined,
      query: query as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });
    res.json(results);
  } else {
    res.json(getAllMemories());
  }
});

// Get single memory
router.get("/:id", (req, res) => {
  const memory = getMemoryById(req.params.id as string);
  if (!memory) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(memory);
});

// Create memory
router.post("/", (req, res) => {
  const { content, category, agentId } = req.body;
  if (!content || !category) {
    res.status(400).json({ error: "content and category are required" });
    return;
  }
  const memory = saveMemory({ content, category, agentId });
  res.status(201).json(memory);
});

// Update memory
router.put("/:id", (req, res) => {
  const { content } = req.body;
  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  const memory = updateMemory(req.params.id as string, content);
  if (!memory) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(memory);
});

// Delete memory
router.delete("/:id", (req, res) => {
  const deleted = deleteMemory(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.status(204).send();
});

export default router;
