// Shared agent-reply delivery.
//
// Both the `chomp_reply` MCP tool and the runner/dispatch failure paths need to
// persist an assistant message, fire the reply callbacks (websocket / Telegram /
// Discord push), and mark the session as having replied. Extracting it here keeps
// that single source of truth so a fallback flush behaves identically to a normal
// reply — same persistence, same agent attribution, same dedupe semantics.

import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { publishLocalImages } from "../lib/chat-images.js";
import { agentSessions, chatMessages, conversations } from "../db/schema.js";
import {
  replyCallbacks,
  markSessionReplied,
  hasSessionReplied,
  getSessionConversationId,
  registerSessionConversation,
  type SessionReply,
} from "./state.js";

/**
 * Resolve which conversation a reply belongs to. Normally the session is bound
 * to a conversation for the duration of the turn. But a reply can arrive under a
 * sessionId whose binding was already cleared — e.g. a reused/long-lived runner
 * process reporting a stale sessionId after a background task re-invokes it. In
 * that orphan case we must NOT drop the reply silently (and must not let another
 * channel grab it): fall back to the most recently active conversation, which —
 * for this single-user system — is the chat the user is currently working in.
 */
function resolveConversationId(sessionId: string): string | undefined {
  const bound = getSessionConversationId(sessionId);
  if (bound) return bound;
  const recent = db
    .select({ id: conversations.id })
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return recent?.id;
}

/**
 * Deliver an assistant message for `sessionId`: persist to chat history (when the
 * session is bound to a conversation), notify reply listeners, and record it as
 * the session's latest reply. This is the shared core used by the `reply` tool.
 */
export function deliverAgentReply(sessionId: string, content: string): SessionReply {
  const session = db
    .select({ agentName: agentSessions.agentName })
    .from(agentSessions)
    .where(eq(agentSessions.sessionId, sessionId))
    .get();

  const reply: SessionReply = {
    id: randomUUID(),
    content: publishLocalImages(content),
    agentUsed: session?.agentName ?? "Chomp",
    createdAt: new Date().toISOString(),
  };

  // Resolve (and, for orphan sessions, recover) the conversation BEFORE firing
  // callbacks, then bind it so the per-channel listeners (web / Telegram /
  // Discord) all route consistently off the same conversation id.
  const convId = resolveConversationId(sessionId);
  if (convId && !getSessionConversationId(sessionId)) {
    registerSessionConversation(sessionId, convId);
  }

  markSessionReplied(sessionId, reply);
  for (const cb of replyCallbacks) cb(sessionId, reply);

  if (convId) {
    db.insert(chatMessages)
      .values({
        id: reply.id,
        conversationId: convId,
        role: "assistant",
        content: reply.content,
        agentUsed: reply.agentUsed,
        turnId: sessionId,
        createdAt: reply.createdAt,
      })
      .run();
  }

  return reply;
}

/**
 * Deliver a reply ONLY if the session has not already produced one this turn.
 *
 * Used by failure/teardown paths so a killed or crashed turn never leaves the
 * user staring at a dead spinner. It is a no-op (returns null) when a reply —
 * intermediate or final — already landed, which makes it structurally impossible
 * to double-post over a message the user already saw.
 */
export function deliverFallbackReply(sessionId: string, content: string): SessionReply | null {
  if (!sessionId) return null;
  if (hasSessionReplied(sessionId)) return null;
  return deliverAgentReply(sessionId, content);
}

/**
 * Turn an internal runner failure message into something a human should see.
 * Internal strings like "Lingering PTY terminated (kill-session)" are useless
 * (and slightly alarming) noise in a chat transcript.
 */
export function humanizeTurnFailure(errorMessage: string): string {
  const msg = (errorMessage || "").toLowerCase();
  // Deliberate user Stops are handled upstream (no fallback is sent for them),
  // so this path only covers involuntary deaths — don't presume *why* it stopped.
  if (/kill-session|terminated|killed|cancel/.test(msg)) {
    return "⏹️ That turn stopped before I could finish my reply. Ask me to continue and I'll pick it back up.";
  }
  if (/timed out|timeout/.test(msg)) {
    return "⏱️ That turn timed out before I could send a reply. Try again, or narrow the ask and I'll move faster.";
  }
  if (/without sending chomp_reply|without a reply/.test(msg)) {
    return "⚠️ I finished working but didn't send a final reply that time. Nudge me and I'll resend it.";
  }
  return `⚠️ Something interrupted that turn before I could reply (${errorMessage}). Give it another go.`;
}
