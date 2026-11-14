import { Router, type Request, type Response } from "express";
import { listBackups, runBackup } from "../lib/backup.js";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ backups: listBackups() });
});

router.post("/run", async (_req: Request, res: Response) => {
  try {
    const result = await runBackup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "backup failed" });
  }
});

export default router;
