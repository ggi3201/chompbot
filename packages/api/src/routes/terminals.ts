import { Router, type NextFunction, type Request, type Response } from "express";
import { homedir } from "node:os";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";
import { previewDir } from "../preview/state.js";
import { terminalAllowed } from "../terminal/access.js";
import { createTerminal, killTerminal, listTerminals } from "../terminal/registry.js";

const router: ReturnType<typeof Router> = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (terminalAllowed(req)) return next();
  res.status(403).json({ error: "Terminals open only over the tailnet or the LAN." });
});

const size = { cols: z.number().int().min(2).max(1_000).optional(), rows: z.number().int().min(1).max(500).optional() };
const createSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("home"), ...size }),
  z.object({ scope: z.literal("chat"), conversationId: z.string().min(1), ...size }),
]);
const listSchema = z.union([
  z.object({ scope: z.literal("home") }),
  z.object({ scope: z.literal("chat"), conversationId: z.string().min(1) }),
  z.object({ scope: z.undefined() }),
]);

const scopeKey = (scope: { scope: "home" } | { scope: "chat"; conversationId: string }) => (scope.scope === "home" ? "home" : `chat:${scope.conversationId}`);
const chatExists = (id: string) => !!db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).get();

// All of them, or ?scope=home, or ?scope=chat&conversationId=…; oldest first
router.get("/", async (req: Request, res: Response) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Give scope=home, or scope=chat with a conversationId." });
    return;
  }
  const { data } = query;
  res.json(await listTerminals(data.scope === undefined ? undefined : scopeKey(data)));
});

router.post("/", async (req: Request, res: Response) => {
  const body = createSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { cols, rows } = body.data;
  if (body.data.scope === "chat" && !chatExists(body.data.conversationId)) {
    res.status(404).json({ error: "No such chat." });
    return;
  }
  // A chat's terminal opens where its agents work, without creating the worktree its first turn would.
  const cwd = body.data.scope === "home" ? homedir() : previewDir(body.data.conversationId);
  res.status(201).json(await createTerminal({ scope: scopeKey(body.data), cwd, cols, rows }));
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await killTerminal(String(req.params.id));
  } catch {
    res.status(404).json({ error: "No such terminal." });
    return;
  }
  res.status(204).end();
});

export default router;
