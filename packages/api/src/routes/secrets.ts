import { Router, type Request, type Response } from "express";
import { saveSecret, getSecret, listSecrets, deleteSecret } from "../lib/secrets.js";

const router: ReturnType<typeof Router> = Router();

/** POST /api/settings/secret — save an encrypted secret */
router.post("/", (req: Request, res: Response) => {
  const { key, value } = req.body;
  if (!key || !value) {
    res.status(400).json({ error: "key and value are required" });
    return;
  }
  saveSecret(key, value);
  res.json({ key, status: "saved" });
});

/** GET /api/settings/secrets — list all secrets with masked values */
router.get("/", (_req: Request, res: Response) => {
  res.json(listSecrets());
});

/** DELETE /api/settings/secret/:key — delete a secret */
router.delete("/:key", (req: Request, res: Response) => {
  const key = req.params.key as string;
  const deleted = deleteSecret(key);
  if (!deleted) {
    res.status(404).json({ error: "Secret not found" });
    return;
  }
  res.json({ key, status: "deleted" });
});

export default router;
