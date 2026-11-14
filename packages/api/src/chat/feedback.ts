/**
 * Routing feedback handler — saves user feedback on routing decisions.
 */
import { db } from "../db/index.js";
import { routingFeedback, chatMessages } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";

interface FeedbackMessage {
  messageId: string;
  feedbackType: "thumbs_up" | "thumbs_down" | "correction";
  correction?: string;
}

export function saveFeedback(msg: FeedbackMessage): void {
  try {
    // Look up the message to get routing and conversation context
    const message = db.select().from(chatMessages).where(eq(chatMessages.id, msg.messageId)).get();
    if (!message) return;

    // Find the user message that triggered this response (the one before it)
    const prevMessages = db.select().from(chatMessages)
      .where(eq(chatMessages.conversationId, message.conversationId))
      .orderBy(desc(chatMessages.createdAt))
      .all();

    const msgIndex = prevMessages.findIndex((m) => m.id === msg.messageId);
    const userMsg = prevMessages.find((m, i) => i > msgIndex && m.role === "user");

    db.insert(routingFeedback).values({
      id: randomUUID(),
      messageId: msg.messageId,
      conversationId: message.conversationId,
      originalRouting: message.routing,
      userMessage: userMsg?.content ?? null,
      feedbackType: msg.feedbackType,
      correction: msg.correction ?? null,
      createdAt: new Date().toISOString(),
    }).run();

    console.log(`[feedback] Saved ${msg.feedbackType} for message ${msg.messageId}`);
  } catch (err) {
    console.warn("[feedback] Failed to save:", err instanceof Error ? err.message : err);
  }
}

/** Get recent negative feedback for injection into triage prompt */
export function getRecentNegativeFeedback(limit = 5): Array<{
  userMessage: string;
  routing: string;
  correction?: string;
}> {
  const feedback = db.select().from(routingFeedback)
    .orderBy(desc(routingFeedback.createdAt))
    .limit(limit * 2) // Get more than needed, then filter
    .all()
    .filter((f) => f.feedbackType === "thumbs_down" || f.feedbackType === "correction");

  return feedback.slice(0, limit).map((f) => ({
    userMessage: f.userMessage ?? "",
    routing: f.originalRouting ?? "unknown",
    correction: f.correction ?? undefined,
  })).filter((f) => f.userMessage);
}
