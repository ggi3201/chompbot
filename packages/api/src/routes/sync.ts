import { Router } from "express";
import { importFromFilesystem } from "../sync/import.js";
import { pushAllToFilesystem } from "../sync/push.js";

const router: ReturnType<typeof Router> = Router();

// POST /api/sync/pull — import skills, MCP servers, plugins from ~/.claude/ into DB
router.post("/pull", (_req, res) => {
  const result = importFromFilesystem();
  res.json({ status: "ok", ...result });
});

// POST /api/sync/push — push all DB records to filesystem
router.post("/push", (_req, res) => {
  const result = pushAllToFilesystem();
  res.json({ status: "ok", ...result });
});

export default router;
