import { Router } from "express";
import { readArtifact } from "../lib/artifacts.js";

const router: ReturnType<typeof Router> = Router();

// Public by UUID, like /api/uploads: a new tab can't send the Bearer token.
// The CSP sandbox gives the page an opaque origin even when opened as a top-level
// tab, so agent-written scripts can't read Chomp's token from localStorage.
router.get("/:id", (req, res) => {
  const html = readArtifact(req.params.id);
  if (html === null) {
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
});

export default router;
