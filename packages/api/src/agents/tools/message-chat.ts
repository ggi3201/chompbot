import { desc, eq } from "drizzle-orm";
import type { AccessMode, AgentProvider } from "@chomp/shared";
import { db } from "../../db/index.js";
import { and, asc, gte } from "drizzle-orm";
import { agentSessions, chatMessages } from "../../db/schema.js";
import { handleChatMessage, type ChatOptions } from "../../chat/handler.js";
import { findChat } from "../../chat/references.js";
import { backgroundContext } from "../../chat/websocket.js";
import { getSessionConversationId } from "../../mcp/state.js";
import { lastTurnOptions } from "../runtime/pool.js";

export const MAX_MESSAGE = 8_000;
// Two agents can keep answering each other; this caps what one chat receives.
const CAP = 5;
const WINDOW_MS = 10 * 60_000;
const received = new Map<string, number[]>();

/** Counts a message to `conversationId`, or refuses it. shortcut: counts live in memory, so a restart resets them. */
export function underCap(conversationId: string, now = Date.now()): boolean {
  const recent = (received.get(conversationId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= CAP) {
    received.set(conversationId, recent);
    return false;
  }
  received.set(conversationId, [...recent, now]);
  return true;
}

/** The chat's own provider and model, so a Codex chat answers as Codex. Falls back to its last session on record. */
function targetRun(conversationId: string): { provider?: AgentProvider; model?: string; effort?: string; soulId?: string } {
  const last = lastTurnOptions(conversationId);
  if (last?.provider === "claude" || last?.provider === "codex") {
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    return { provider: last.provider, model: text(last.model), effort: text(last.effort), soulId: text(last.soulId) };
  }
  const session = db.select({ agentType: agentSessions.agentType, model: agentSessions.model })
    .from(agentSessions).where(eq(agentSessions.conversationId, conversationId)).orderBy(desc(agentSessions.startedAt)).limit(1).get();
  if (!session) return {};
  return { provider: session.agentType === "codex-sdk" ? "codex" : "claude", ...(session.model ? { model: session.model } : {}) };
}

/** Runs `content` as a turn in a chat, on that chat's own provider and model. Resolves when the turn ends. */
export function startTurnIn(conversationId: string, content: string, extra: ChatOptions = {}): Promise<void> {
  return handleChatMessage(content, backgroundContext(conversationId), undefined, {
    ...targetRun(conversationId),
    ...extra,
    deliveryChannel: "web-chat",
  });
}

/** What the chat's agent wrote since `since`, oldest first. */
export function repliesSince(conversationId: string, since: string): string {
  return db.select({ content: chatMessages.content }).from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "assistant"), gte(chatMessages.createdAt, since)))
    .orderBy(asc(chatMessages.createdAt))
    .all()
    .map((reply) => reply.content)
    .join("\n\n");
}

/** Starts a turn in another chat with a message from this one. It does not wait for the answer, so two chats can never deadlock. */
export function execMessageChat(args: { conversationId: string; message: string }, sessionId?: string): string {
  const from = sessionId ? getSessionConversationId(sessionId) : undefined;
  if (!from) return "ERROR: message_chat works only from a chat's agent turn.";
  const message = (args.message ?? "").trim();
  if (!message) return "ERROR: message is empty.";
  if (message.length > MAX_MESSAGE) return `ERROR: message is longer than ${MAX_MESSAGE} characters.`;
  const target = findChat(String(args.conversationId ?? ""));
  if (!target) return `ERROR: no chat with id ${args.conversationId}. Find ids with list_conversations.`;
  if (target.id === from) return "ERROR: that is this chat.";
  const title = target.title ?? "Untitled";
  if (!underCap(target.id)) return `ERROR: "${title}" already got ${CAP} agent messages in the last 10 minutes. Stop messaging it and tell the user instead.`;

  const sender = findChat(from)?.title ?? "Untitled";
  // The sender's access, so a supervised agent cannot escape supervision by asking another chat.
  const access = lastTurnOptions(from)?.access as AccessMode | undefined;
  const content = `**From chat "${sender}":** ${message}\n\n_If an answer is needed, send it with message_chat to conversation ${from}._`;
  startTurnIn(target.id, content, access ? { access } : {})
    .catch((err) => console.error(`[message_chat] Turn in ${target.id} failed:`, err));
  return `Sent to "${title}". Its agent answers in that chat, and can message you back with message_chat.`;
}
