import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { markPosted } from "../agents/tools/social-posts.js";
import { listSocialPosts } from "../social-posts/store.js";

const router: ReturnType<typeof Router> = Router();
const postedSchema = z.object({ platform: z.enum(["instagram", "tiktok", "pinterest"]) });

router.get("/", (_req: Request, res: Response) => {
  res.json({ posts: listSocialPosts() });
});

router.post("/:id/posted", async (req: Request, res: Response) => {
  const body = postedSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "platform must be instagram, tiktok or pinterest" });
    return;
  }
  const post = await markPosted(String(req.params.id), body.data.platform);
  if (!post) {
    res.status(404).json({ error: "No such post on that platform" });
    return;
  }
  res.json({ post });
});

export default router;

/** Telegram only links to http(s), so this hands the tap to the app. It reveals nothing about the post. */
export const socialPostLinkRoutes: ReturnType<typeof Router> = Router();
socialPostLinkRoutes.get("/:id", (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(404).send("Not found");
    return;
  }
  res.redirect(`chomp://post/${id.data}`);
});
