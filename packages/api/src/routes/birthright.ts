import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { saveBirth } from "../birthright/birth.js";
import { runInterviewTurn } from "../birthright/interview.js";
import { runTrial } from "../birthright/trial.js";
import { VALID_VOICES } from "./voice.js";

const router: ReturnType<typeof Router> = Router();

const KEEPALIVE_MS = 15_000;

const turnSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000).optional(),
}).refine((turn) => !turn.sessionId === !turn.message, {
  message: "A new session takes no message, and a resumed one needs one",
});

const birthSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400),
  content: z.string().trim().min(1).max(10_000),
  profile: z.string().trim().max(20_000).optional(),
  voice: z.enum(VALID_VOICES).optional(),
});

const trialSchema = z.object({ soul: z.string().trim().min(1).max(10_000) });

/**
 * POST /api/birthright/turn
 * Body: { sessionId?: string, message?: string }. No fields starts the interview.
 * Returns: a stream of server-sent events, one InterviewEvent each, then { type: "done" }.
 */
router.post("/turn", async (req: Request, res: Response) => {
  const turn = turnSchema.safeParse(req.body);
  if (!turn.success) {
    res.status(400).json({ error: turn.error.issues[0]?.message ?? "Invalid turn" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // Thinking at high effort can stay silent for longer than a proxy's idle timeout.
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  const abortController = new AbortController();
  res.on("close", () => abortController.abort());

  try {
    for await (const event of runInterviewTurn({ ...turn.data, abortController })) send(event);
    send({ type: "done" });
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error("[birthright] Turn failed:", err);
      send({ type: "error", message: err instanceof Error ? err.message : "The turn failed" });
    }
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

/**
 * POST /api/birthright/birth
 * Body: the finished soul, plus the optional profile and voice.
 * Replaces the one default soul. Running it again updates the same row.
 */
router.post("/birth", (req: Request, res: Response) => {
  const birth = birthSchema.safeParse(req.body);
  if (!birth.success) {
    res.status(400).json({ error: birth.error.issues[0]?.message ?? "Invalid soul" });
    return;
  }
  res.json({ id: saveBirth(birth.data) });
});

/**
 * POST /api/birthright/trial
 * Body: { soul: string }
 * Returns real messages answered by this soul and by the current one, in random order.
 */
router.post("/trial", async (req: Request, res: Response) => {
  const trial = trialSchema.safeParse(req.body);
  if (!trial.success) {
    res.status(400).json({ error: trial.error.issues[0]?.message ?? "Invalid soul" });
    return;
  }
  const abortController = new AbortController();
  res.on("close", () => abortController.abort());
  try {
    res.json(await runTrial(trial.data.soul, abortController));
  } catch (err) {
    if (abortController.signal.aborted) return;
    console.error("[birthright] Trial failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "The test failed" });
  }
});

export default router;
