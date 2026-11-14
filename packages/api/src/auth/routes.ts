import { Router, type Request, type Response } from "express";
import { isSetup, setupPassword, verifyPassword } from "./password.js";
import { createToken } from "./middleware.js";

const router: ReturnType<typeof Router> = Router();

router.get("/status", async (_req: Request, res: Response) => {
  const setup = await isSetup();
  res.json({ isSetup: setup });
});

router.post("/setup", async (req: Request, res: Response) => {
  const setup = await isSetup();
  if (setup) {
    res.status(400).json({ error: "Already set up" });
    return;
  }
  const { password } = req.body;
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  await setupPassword(password);
  const token = createToken();
  res.json({ token });
});

router.post("/login", async (req: Request, res: Response) => {
  const { password, longLived } = req.body;
  const valid = await verifyPassword(password);
  if (!valid) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  const token = createToken({ longLived: longLived === true });
  res.json({ token });
});

export default router;
