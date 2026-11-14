import { Router, type Request, type Response } from "express";
import { loadReport, reportUrl } from "../goodmorning/report.js";
import { getUserTimezone } from "../proactive/engine.js";

const router: ReturnType<typeof Router> = Router();

/** What the iOS home page shows of today. The report's own route takes a link key, which the app does not have. */
router.get("/", (_req: Request, res: Response) => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: getUserTimezone() }).format(new Date());
  const report = loadReport(date);
  res.json({
    date,
    report: report && { place: report.place, headline: report.headline, weather: report.weather },
    reportUrl: report ? reportUrl(date) : null,
  });
});

export default router;
