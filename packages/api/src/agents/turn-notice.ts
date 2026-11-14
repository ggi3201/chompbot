import { and, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages } from "../db/schema.js";
import { notify, type NotificationChannel, type NotificationType } from "../notifications/router.js";

/**
 * Where a background turn's result goes when it finishes (Telegram, Discord).
 * Saved with the running turn, so a turn resumed after a restart can still send it.
 */
export interface TurnNotice {
  type: NotificationType;
  title: string;
  conversationId: string;
  /** Replies from here on belong to this run. */
  since: string;
  channels?: NotificationChannel[];
}

/** How a scheduled run says it has nothing to report. */
const SILENT = "[SILENT]";

/** Sends the turn's replies, or its final text if it wrote none. Returns what was sent. */
export async function sendTurnNotice(notice: TurnNotice, finalText: string | undefined): Promise<string | undefined> {
  const { since, ...delivery } = notice;
  const replies = db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.conversationId, notice.conversationId),
      eq(chatMessages.role, "assistant"),
      gte(chatMessages.createdAt, since),
    ))
    .all();
  const texts = replies.length > 0 ? replies.map((m) => m.content) : [finalText ?? ""];
  const body = texts.filter((text) => text.trim() !== SILENT).join("\n\n");
  if (!body) return undefined;
  await notify({ ...delivery, body, broadcast: true });
  return body;
}
