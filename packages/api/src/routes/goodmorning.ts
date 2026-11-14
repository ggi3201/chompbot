import { Router, type Request, type Response, type NextFunction } from "express";
import { dateSchema, isReportKey, loadReport, reportConversationId, voicePath } from "../goodmorning/report.js";
import { loadWeek } from "../goodmorning/week.js";

const router: ReturnType<typeof Router> = Router();

function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!isReportKey(req.query.key)) {
    res.status(401).json({ error: "Invalid key" });
    return;
  }
  next();
}

function requestedDate(req: Request, res: Response): string | null {
  const date = dateSchema.safeParse(req.params.date);
  if (!date.success) res.status(400).json({ error: "Date must be YYYY-MM-DD" });
  return date.success ? date.data : null;
}

router.use(requireKey);

router.get("/:date", async (req: Request, res: Response) => {
  const date = requestedDate(req, res);
  if (!date) return;
  const report = loadReport(date);
  res.json({ report, conversationId: reportConversationId(date), hasVoice: voicePath(date) !== null, week: await loadWeek(date, report?.travel) });
});

router.get("/:date/voice.mp3", (req: Request, res: Response) => {
  const date = requestedDate(req, res);
  if (!date) return;
  const file = voicePath(date);
  if (!file) {
    res.status(404).json({ error: "No voice note for that day" });
    return;
  }
  res.sendFile(file);
});

export default router;
