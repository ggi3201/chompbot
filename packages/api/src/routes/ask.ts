import { randomUUID } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pushToPhones } from "../agents/tools/phone-cards.js";
import { handleChatMessage } from "../chat/handler.js";
import { db } from "../db/index.js";
import { chatMessages, conversations } from "../db/schema.js";
import { sendAlertPush } from "../lib/apns.js";
import { notify } from "../notifications/router.js";

/** iOS ends an action that runs too long, so the phone must get its answer before that. */
const REPLY_WAIT_MS = 25_000;
const PUSH_BODY_MAX = 1000;
const TITLE = "Chomp";

const CHANNEL_CONTEXT = [
  "This came from the Ask Chomp action on the user's iPhone, through Shortcuts or Siri.",
  "Always answer. Your answer is shown in a small panel and may be read aloud, so use a few plain sentences, with no Markdown.",
  "An attached image is usually a screenshot of what they are looking at. If they sent only an image, say what matters in it and what you could do about it.",
].join(" ");

const askSchema = z.object({
  question: z.string().trim().max(10_000).default(""),
  attachments: z.array(z.object({
    url: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
  })).max(4).default([]),
}).refine(({ question, attachments }) => question || attachments.length > 0, "Send a question or an image");

function replyIn(conversationId: string): string {
  const replies = db.select({ content: chatMessages.content }).from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "assistant")))
    .orderBy(asc(chatMessages.createdAt))
    .all();
  return replies.map((reply) => reply.content).join("\n\n") || "Chomp finished without an answer. Open the chat to see what it did.";
}

/** The phone stopped waiting, so the answer has to come to it. Other channels are for when push cannot. */
async function sendLateReply(conversationId: string): Promise<void> {
  const reply = replyIn(conversationId);
  const body = reply.length > PUSH_BODY_MAX ? `${reply.slice(0, PUSH_BODY_MAX - 1)}…` : reply;
  const failure = await pushToPhones((phone) => sendAlertPush({ ...phone, title: TITLE, body }));
  if (failure) await notify({ type: "agent-complete", title: TITLE, body: reply, conversationId, broadcast: true });
}

export function askRoutes(replyWaitMs = REPLY_WAIT_MS): ReturnType<typeof Router> {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const ask = askSchema.safeParse(req.body);
    if (!ask.success) {
      res.status(400).json({ error: ask.error.issues.map((issue) => issue.message).join("; ") });
      return;
    }

    const conversationId = randomUUID();
    const now = new Date().toISOString();
    db.insert(conversations).values({ id: conversationId, createdAt: now, updatedAt: now }).run();

    const turn = handleChatMessage(ask.data.question, { conversationId, send: () => {} }, ask.data.attachments, {
      channelContext: CHANNEL_CONTEXT,
      deliveryChannel: "proactive",
      notifyWhenDone: { type: "agent-complete", title: TITLE, conversationId, since: now },
    });

    let timer: NodeJS.Timeout | undefined;
    const answered = await Promise.race([
      turn.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), replyWaitMs); }),
    ]);
    clearTimeout(timer);

    if (answered) {
      res.json({ conversationId, reply: replyIn(conversationId) });
      return;
    }
    res.json({ conversationId, reply: null });
    turn.then(() => sendLateReply(conversationId)).catch((err) => console.error("[ask] Late reply failed:", err));
  });

  return router;
}
