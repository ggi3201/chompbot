import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatItems } from "../db/schema.js";
import { pendingQuestionSessionIds } from "../mcp/pending-questions.js";
import { getSessionConversationId } from "../mcp/state.js";

/**
 * Chats whose agent is waiting on the user: an ask_user question, or an approval.
 * Approvals count only in running chats, since a crashed turn can leave one marked pending.
 */
export function conversationsNeedingInput(running: Set<string>): Set<string> {
  const waiting = new Set<string>();
  for (const sessionId of pendingQuestionSessionIds()) {
    const conversationId = getSessionConversationId(sessionId);
    if (conversationId) waiting.add(conversationId);
  }
  if (running.size > 0) {
    const approvals = db
      .selectDistinct({ conversationId: chatItems.conversationId })
      .from(chatItems)
      .where(and(
        inArray(chatItems.conversationId, [...running]),
        eq(chatItems.kind, "approval"),
        sql`json_extract(${chatItems.payload}, '$.state') = 'pending'`,
      ))
      .all();
    for (const { conversationId } of approvals) waiting.add(conversationId);
  }
  return waiting;
}
