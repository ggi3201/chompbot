import { Router, type Request, type Response } from "express";
import { listPhoneCards } from "../phone-cards/store.js";

const router: ReturnType<typeof Router> = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ cards: listPhoneCards() });
});

export default router;
