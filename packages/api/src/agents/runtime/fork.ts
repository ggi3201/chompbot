import { randomUUID } from "crypto";
import { homedir } from "os";
import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../../db/index.js";
import { agentSessions, chatItems, chatMessages, conversations } from "../../db/schema.js";
import { CodexRpc } from "./codex-rpc.js";
import { orphanedSubagentPayload } from "./items.js";

/**
 * Fork a conversation at one of its messages: a new conversation with the
 * chat and the agent's work up to that point, and — where the CLI can — its
 * native session forked at the same turn, so the agent remembers everything,
 * tool results included. Where the native fork fails, the new conversation
 * starts a fresh session and the dispatcher hands it the transcript.
 */
export async function forkConversation(conversationId: string, messageId: string): Promise<{ id: string; nativeForked: boolean }> {
  const source = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!source) throw new Error("Conversation not found");
  const message = db.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.conversationId, conversationId))).get();
  if (!message) throw new Error("Message not found");
  const cutoff = message.createdAt;

  const id = randomUUID();
  const now = new Date().toISOString();
  const messages = db.select().from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), lte(chatMessages.createdAt, cutoff)))
    .orderBy(asc(chatMessages.createdAt))
    .all();
  const items = db.select().from(chatItems)
    .where(and(eq(chatItems.conversationId, conversationId), lte(chatItems.createdAt, cutoff)))
    .orderBy(asc(chatItems.seq))
    .all();

  // The last finished agent turn at or before the fork point is where the native session forks.
  const turn = db.select().from(agentSessions)
    .where(and(eq(agentSessions.conversationId, conversationId), lte(agentSessions.startedAt, cutoff), isNotNull(agentSessions.nativeRef)))
    .orderBy(desc(agentSessions.startedAt))
    .limit(1)
    .get();
  const native = turn ? await forkNativeSession(turn).catch((err) => {
    console.warn("[fork] Native fork failed, the fork will start a fresh session:", err instanceof Error ? err.message : err);
    return null;
  }) : null;

  db.transaction((tx) => {
    tx.insert(conversations).values({
      id,
      title: `${source.title ?? "Chat"} (fork)`,
      pinnedAgent: source.pinnedAgent,
      soulId: source.soulId,
      projectPath: source.projectPath,
      // shortcut: a fork shares its parent's worktree because the CLI resumes the forked session by directory; give it its own once forks fork into a new dir.
      worktreePath: source.worktreePath,
      parentId: conversationId,
      parentKind: "fork",
      ...(native?.engine === "claude" ? { ccSessionId: native.sessionId } : {}),
      ...(native?.engine === "codex" ? { codexSessionId: native.sessionId } : {}),
      createdAt: now,
      updatedAt: now,
    }).run();
    for (const m of messages) {
      tx.insert(chatMessages).values({ ...m, id: randomUUID(), conversationId: id }).run();
    }
    items.forEach((item, index) => {
      const parentId = item.parentId && `${id}:${item.parentId}`;
      const payload = item.kind === "subagent" ? orphanedSubagentPayload(item.payload) : item.payload;
      tx.insert(chatItems).values({ ...item, payload, id: `${id}:${item.id}`, parentId, conversationId: id, seq: index + 1 }).run();
    });
  });

  return { id, nativeForked: !!native };
}

async function forkNativeSession(turn: typeof agentSessions.$inferSelect): Promise<{ engine: "claude" | "codex"; sessionId: string } | null> {
  if (!turn.ccSessionId || !turn.nativeRef) return null;
  if (turn.agentType === "claude-sdk") {
    const forked = await forkSession(turn.ccSessionId, { dir: turn.cwd ?? undefined, upToMessageId: turn.nativeRef });
    return { engine: "claude", sessionId: forked.sessionId };
  }
  if (turn.agentType === "codex-sdk") {
    const rpc = new CodexRpc([], { cwd: turn.cwd ?? homedir(), env: process.env });
    try {
      await rpc.request("initialize", { clientInfo: { name: "chomp", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      const forked = await rpc.request<{ thread: { id: string } }>("thread/fork", { threadId: turn.ccSessionId, lastTurnId: turn.nativeRef, excludeTurns: true });
      return { engine: "codex", sessionId: forked.thread.id };
    } finally {
      rpc.close();
    }
  }
  return null;
}
