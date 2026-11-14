import { Router, type Response } from "express";
import { addStrokes, readSketch, removeLastUserStroke, updateSketch, type StrokeInput } from "../lib/sketches.js";

const router: ReturnType<typeof Router> = Router();

function respond(res: Response, run: () => unknown) {
  try {
    res.json(run());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Bad sketch request" });
  }
}

router.get("/:id", (req, res) => {
  const sketch = readSketch(req.params.id);
  if (!sketch) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(sketch);
});

router.post("/:id/strokes", (req, res) => {
  const { strokes } = req.body as { strokes?: StrokeInput[] };
  respond(res, () => {
    if (!Array.isArray(strokes)) throw new Error("strokes must be an array");
    return addStrokes(req.params.id, strokes, "user");
  });
});

router.delete("/:id/strokes/last", (req, res) => respond(res, () => removeLastUserStroke(req.params.id)));

router.patch("/:id", (req, res) => {
  const { turn, reference } = req.body as { turn?: unknown; reference?: unknown };
  respond(res, () => updateSketch(req.params.id, { turn, reference }));
});

export default router;
