import { Router, type Request, type Response } from "express";
import type { CloneEvent } from "@chomp/shared";
import { CloneError, cloneRepo, listProjects, listRemoteRepos } from "../lib/projects.js";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json(listProjects());
});

// GitHub repos the host's gh can see that are not cloned under ~/code yet
router.get("/remote", async (_req: Request, res: Response) => {
  res.json(await listRemoteRepos());
});

// Clone one of them. Refusals answer with a status and JSON; once the clone
// starts, the answer streams CloneEvent lines, since a big repo takes minutes.
router.post("/clone", async (req: Request, res: Response) => {
  const nameWithOwner = req.body?.nameWithOwner;
  if (typeof nameWithOwner !== "string") {
    res.status(400).json({ error: "nameWithOwner must be a string" });
    return;
  }
  const send = (event: CloneEvent) => res.write(`${JSON.stringify(event)}\n`);
  try {
    const project = await cloneRepo(nameWithOwner, {
      onStart: () => {
        res.status(200);
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
      },
      onProgress: (text) => send({ type: "progress", text }),
    });
    send({ type: "done", project });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(err instanceof CloneError ? err.status : 500).json({ error });
      return;
    }
    send({ type: "error", error });
  }
  res.end();
});

export default router;
