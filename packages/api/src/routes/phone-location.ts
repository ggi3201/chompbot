import { Router, type Request, type Response } from "express";
import { ingestLocation, reportSchema } from "../location/store.js";

const router: ReturnType<typeof Router> = Router();

const phoneReportSchema = reportSchema.omit({ source: true, place: true });

router.post("/", (req: Request, res: Response) => {
  const report = phoneReportSchema.safeParse(req.body);
  if (!report.success) {
    res.status(400).json({ error: report.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    return;
  }
  ingestLocation({ ...report.data, source: "phone" });
  res.status(204).end();
});

export default router;
