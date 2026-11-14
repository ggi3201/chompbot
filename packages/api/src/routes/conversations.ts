import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { conversations, chatMessages, agentSessions } from "../db/schema.js";
import { eq, desc, like, and, isNull, notLike, or, lt, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { basename } from "path";
import { getActiveSessions } from "../agents/registry.js";
import { listChatItems } from "../agents/runtime/items.js";
import { forkConversation } from "../agents/runtime/fork.js";
import { closeConversationRuntime, conversationContextUsage } from "../agents/runtime/pool.js";
import { DEFAULT_AGENT_CWD } from "../agents/runtime/claude.js";
import { projectGitState } from "../lib/projects.js";
import { removeConversationWorktree } from "../agents/worktree.js";
import { suggestTitle } from "../chat/title.js";
import { conversationsNeedingInput } from "../chat/needs-input.js";
import { markConversationSeen, unreadConversations } from "../chat/unread.js";

const router: ReturnType<typeof Router> = Router();
const PROACTIVE_CONVERSATION_PREFIXES = ["Proactive:", "Schedule:", "Trigger:"] as const;
const DEFAULT_CONVERSATION_LIMIT = 100;
const MAX_CONVERSATION_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

function boundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function shouldHideProactive(req: Request): boolean {
  return req.query.hideProactive !== "false";
}

function proactiveConversationCondition() {
  return and(
    ...PROACTIVE_CONVERSATION_PREFIXES.map((prefix) =>
      or(isNull(conversations.title), notLike(conversations.title, `${prefix}%`))
    )
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);
  if (index === -1) return escapeHtml(content.slice(0, 160));

  const start = Math.max(index - 60, 0);
  const end = Math.min(index + query.length + 80, content.length);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  const before = escapeHtml(content.slice(start, index));
  const match = escapeHtml(content.slice(index, index + query.length));
  const after = escapeHtml(content.slice(index + query.length, end));
  return `${prefix}${before}<mark>${match}</mark>${after}${suffix}`;
}

// Search conversations by message content (FTS5) with LIKE title fallback
// Must be defined before /:id routes to avoid being matched as an ID
router.get("/search", (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 50);
  const hideProactive = shouldHideProactive(req);

  if (!q) {
    res.json([]);
    return;
  }

  // Use raw better-sqlite3 client for FTS5 MATCH and LIKE backup queries.
  const sqlite = (db as { $client: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).$client;
  type SearchRow = {
    conversationId: string;
    conversationTitle: string | null;
    updatedAt: string;
    messageId: string | null;
    role: string | null;
    snippet: string;
  };

  const exactRows = sqlite
    .prepare(
      `SELECT
        cm.conversation_id AS conversationId,
        c.title AS conversationTitle,
        c.updated_at AS updatedAt,
        cm.id AS messageId,
        cm.role,
        cm.content AS content
      FROM chat_messages cm
      JOIN conversations c ON cm.conversation_id = c.id
      WHERE (cm.content LIKE ? OR c.title LIKE ?)
      ${hideProactive ? "AND (c.title IS NULL OR (c.title NOT LIKE 'Proactive:%' AND c.title NOT LIKE 'Schedule:%' AND c.title NOT LIKE 'Trigger:%'))" : ""}
      ORDER BY c.updated_at DESC
      LIMIT ?`
    )
    .all(`%${q}%`, `%${q}%`, limit * 5) as Array<{
      conversationId: string;
      conversationTitle: string | null;
      updatedAt: string;
      messageId: string;
      role: string;
      content: string;
    }>;

  const seen = new Set<string>();
  const results: SearchRow[] = [];
  for (const row of exactRows) {
    if (results.length >= limit) break;
    if (seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);
    results.push({
      conversationId: row.conversationId,
      conversationTitle: row.conversationTitle,
      updatedAt: row.updatedAt,
      messageId: row.messageId,
      role: row.role,
      snippet: textSnippet(row.content || row.conversationTitle || "", q),
    });
  }

  try {
    const ftsRows = sqlite
      .prepare(
        `SELECT
          cm.conversation_id AS conversationId,
          c.title AS conversationTitle,
          c.updated_at AS updatedAt,
          cm.id AS messageId,
          cm.role,
          snippet(chat_messages_fts, 2, '<mark>', '</mark>', '…', 15) AS snippet
        FROM chat_messages_fts
        JOIN chat_messages cm ON chat_messages_fts.message_id = cm.id
        JOIN conversations c ON cm.conversation_id = c.id
        WHERE chat_messages_fts MATCH ?
        ${hideProactive ? "AND (c.title IS NULL OR (c.title NOT LIKE 'Proactive:%' AND c.title NOT LIKE 'Schedule:%' AND c.title NOT LIKE 'Trigger:%'))" : ""}
        ORDER BY rank
        LIMIT ?`
      )
      .all(`${q}*`, Math.max(limit * 50, 1000)) as Array<{
        conversationId: string;
        conversationTitle: string | null;
        updatedAt: string;
        messageId: string;
        role: string;
        snippet: string;
      }>;

    // Deduplicate: keep only the best-ranked result per conversation
    for (const row of ftsRows) {
      if (results.length >= limit) break;
      if (seen.has(row.conversationId)) continue;
      seen.add(row.conversationId);
      results.push(row);
    }

    res.json(results);
  } catch {
    // FTS5 may reject punctuation-heavy queries. Keep search useful by falling
    // back to substring matching across both message text and titles.
    const rows = sqlite
      .prepare(
        `SELECT
          cm.conversation_id AS conversationId,
          c.title AS conversationTitle,
          c.updated_at AS updatedAt,
          cm.id AS messageId,
          cm.role,
          cm.content AS content
        FROM chat_messages cm
        JOIN conversations c ON cm.conversation_id = c.id
        WHERE (cm.content LIKE ? OR c.title LIKE ?)
        ${hideProactive ? "AND (c.title IS NULL OR (c.title NOT LIKE 'Proactive:%' AND c.title NOT LIKE 'Schedule:%' AND c.title NOT LIKE 'Trigger:%'))" : ""}
        ORDER BY c.updated_at DESC
        LIMIT ?`
      )
      .all(`%${q}%`, `%${q}%`, limit * 5) as Array<{
        conversationId: string;
        conversationTitle: string | null;
        updatedAt: string;
        messageId: string;
        role: string;
        content: string;
      }>;

    for (const row of rows) {
      if (results.length >= limit) break;
      if (seen.has(row.conversationId)) continue;
      seen.add(row.conversationId);
      results.push({
        conversationId: row.conversationId,
        conversationTitle: row.conversationTitle,
        updatedAt: row.updatedAt,
        messageId: row.messageId,
        role: row.role,
        snippet: textSnippet(row.content || row.conversationTitle || "", q),
      });
    }

    res.json(results);
  }
});

// List all unique tags across conversations
router.get("/tags", (_req: Request, res: Response) => {
  const rows = db.select({ tags: conversations.tags }).from(conversations).all();
  const tagSet = new Set<string>();
  for (const row of rows) {
    const parsed = JSON.parse(row.tags) as string[];
    for (const t of parsed) tagSet.add(t);
  }
  res.json([...tagSet].sort());
});

// Export a conversation as markdown or JSON
router.get("/:id/export", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const format = (req.query.format as string) || "markdown";

  const convo = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!convo) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const msgs = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, id))
    .orderBy(chatMessages.createdAt)
    .all();

  const sessions = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, id))
    .all();

  if (format === "json") {
    const exportData = {
      id: convo.id,
      title: convo.title,
      pinnedAgent: convo.pinnedAgent,
      createdAt: convo.createdAt,
      updatedAt: convo.updatedAt,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        agentUsed: m.agentUsed,
        createdAt: m.createdAt,
      })),
      agentSessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        agentName: s.agentName,
        model: s.model,
        status: s.status,
        durationMs: s.durationMs,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      })),
      exportedAt: new Date().toISOString(),
    };

    const filename = `chomp-${(convo.title || "conversation").replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 50)}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.json(exportData);
    return;
  }

  // Markdown format
  const title = convo.title || "Untitled Conversation";
  const date = convo.createdAt ? new Date(convo.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
  const lines: string[] = [`# ${title}`, ""];
  if (date) lines.push(`*${date}*`, "");

  for (const m of msgs) {
    const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "";
    const role = m.role === "user" ? "**User**" : m.agentUsed ? `**Chomp** (${m.agentUsed})` : "**Chomp**";
    lines.push(`${role} · ${time}`, m.content, "");
  }

  lines.push("---");
  const sessionCount = sessions.length;
  lines.push(`*Exported from Chomp · ${msgs.length} messages${sessionCount > 0 ? ` · ${sessionCount} agent session${sessionCount !== 1 ? "s" : ""}` : ""}*`);

  const md = lines.join("\n");
  const filename = `chomp-${(convo.title || "conversation").replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 50)}.md`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(md);
});

// List all conversations (with optional tag/pinned filtering)
router.get("/", (req: Request, res: Response) => {
  const tagFilter = req.query.tag as string | undefined;
  const pinnedFilter = req.query.pinned as string | undefined;
  const hideProactive = shouldHideProactive(req);
  const limit = boundedInt(req.query.limit, DEFAULT_CONVERSATION_LIMIT, MAX_CONVERSATION_LIMIT);
  const offset = Math.max(Number.parseInt((req.query.offset as string) || "0", 10) || 0, 0);

  const conditions = [];
  if (pinnedFilter === "true") conditions.push(eq(conversations.pinned, true));
  if (tagFilter) conditions.push(like(conversations.tags, `%"${tagFilter}"%`));
  if (hideProactive) conditions.push(proactiveConversationCondition());
  // A chat nobody wrote in (an unused "New chat", a proactive run that stayed silent) is not worth a row.
  conditions.push(sql`exists (select 1 from ${chatMessages} where ${chatMessages.conversationId} = ${conversations.id})`);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const result = db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
    .limit(limit + 1)
    .offset(offset)
    .all();

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;

  // Conversations with a live agent session in the registry get a running flag
  // so the client can show a spinner on the row — even for background chats the
  // user isn't currently viewing.
  const runningConversationIds = new Set(
    getActiveSessions()
      .filter((s) => s.status === "running" && s.conversationId)
      .map((s) => s.conversationId as string),
  );

  const needsInputIds = conversationsNeedingInput(runningConversationIds);
  const unreadIds = unreadConversations(page.map((c) => c.id));

  // Parse tags from JSON string to array for the client
  res.setHeader("X-Has-More", hasMore ? "true" : "false");
  res.json(page.map((c) => ({
    ...c,
    tags: JSON.parse(c.tags) as string[],
    running: runningConversationIds.has(c.id),
    needsInput: needsInputIds.has(c.id),
    unread: unreadIds.has(c.id),
  })));
});

// Get messages for a conversation
router.get("/:id/messages", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const limit = boundedInt(req.query.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const before = (req.query.before as string | undefined)?.trim();
  const convo = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!convo) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const conditions = [eq(chatMessages.conversationId, id)];
  if (before) conditions.push(lt(chatMessages.createdAt, before));

  const result = db
    .select()
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit + 1)
    .all();

  const hasMore = result.length > limit;
  const msgs = (hasMore ? result.slice(0, limit) : result).reverse();

  res.setHeader("X-Has-More", hasMore ? "true" : "false");
  res.json(
    msgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      agentUsed: m.agentUsed,
      turnId: m.turnId ?? undefined,
      source: m.source ?? undefined,
      createdAt: m.createdAt,
    }))
  );
});

// Fork at a message: a new conversation with everything up to it
router.post("/:id/fork", async (req: Request, res: Response) => {
  const messageId = typeof req.body?.messageId === "string" ? req.body.messageId : "";
  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }
  try {
    res.status(201).json(await forkConversation(req.params.id as string, messageId));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Fork failed" });
  }
});

// What the conversation last ran with, so a chat without a stored model choice
// reopens on its own engine, model and soul rather than the last one used anywhere.
router.get("/:id/last-selection", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const convo = db.select({ soulId: conversations.soulId }).from(conversations).where(eq(conversations.id, id)).get();
  if (!convo) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const last = db.select({ agentType: agentSessions.agentType, model: agentSessions.model })
    .from(agentSessions)
    .where(and(eq(agentSessions.conversationId, id), or(eq(agentSessions.agentType, "claude-sdk"), eq(agentSessions.agentType, "codex-sdk"))))
    .orderBy(desc(agentSessions.startedAt))
    .limit(1)
    .get();
  res.json({
    ...(last ? { provider: last.agentType === "claude-sdk" ? "claude" : "codex", ...(last.model ? { model: last.model } : {}) } : {}),
    ...(convo.soulId ? { soulId: convo.soulId } : {}),
  });
});

// What the info panel shows: where the agent runs, its sessions, and the chats this one came from or led to
router.get("/:id/info", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const convo = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!convo) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const lastTurn = (agentType: "claude-sdk" | "codex-sdk") => db
    .select({ model: agentSessions.model, cwd: agentSessions.cwd, startedAt: agentSessions.startedAt })
    .from(agentSessions)
    .where(and(eq(agentSessions.conversationId, id), eq(agentSessions.agentType, agentType)))
    .orderBy(desc(agentSessions.startedAt))
    .limit(1)
    .get();
  const sessions = [];
  if (convo.ccSessionId) {
    const turn = lastTurn("claude-sdk");
    const cwd = turn?.cwd ?? DEFAULT_AGENT_CWD;
    // Claude keeps sessions per directory, so the resume only works from the one it ran in.
    sessions.push({ provider: "claude", sessionId: convo.ccSessionId, model: turn?.model ?? null, cwd, lastTurnAt: turn?.startedAt ?? null, resume: `cd ${cwd} && claude --resume ${convo.ccSessionId}` });
  }
  if (convo.codexSessionId) {
    const turn = lastTurn("codex-sdk");
    sessions.push({ provider: "codex", sessionId: convo.codexSessionId, model: turn?.model ?? null, cwd: turn?.cwd ?? DEFAULT_AGENT_CWD, lastTurnAt: turn?.startedAt ?? null, resume: `codex resume ${convo.codexSessionId}` });
  }
  const link = (row: { id: string; title: string | null }, kind: string | null) => ({ id: row.id, title: row.title, kind: kind === "handoff" ? "handoff" : "fork" });
  const parent = convo.parentId
    ? db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(eq(conversations.id, convo.parentId)).get()
    : undefined;
  const children = db.select({ id: conversations.id, title: conversations.title, kind: conversations.parentKind })
    .from(conversations)
    .where(eq(conversations.parentId, id))
    .orderBy(conversations.createdAt)
    .all();
  const project = convo.projectPath
    ? { name: basename(convo.projectPath), path: convo.projectPath, git: await projectGitState(convo.worktreePath ?? convo.projectPath) }
    : null;
  res.json({
    host: hostname(),
    project,
    sessions,
    parent: parent ? link(parent, convo.parentKind) : null,
    children: children.map((child) => link(child, child.kind)),
  });
});

// How full the conversation's agent session is; null before its first agent turn
router.get("/:id/context", async (req: Request, res: Response) => {
  res.json(await conversationContextUsage(req.params.id as string));
});

// Structured agent output for a conversation, oldest first
router.get("/:id/items", (req: Request, res: Response) => {
  const afterSeq = boundedInt(req.query.afterSeq, 0, Number.MAX_SAFE_INTEGER);
  res.json(listChatItems(req.params.id as string, afterSeq));
});

// A model-written title for what the chat is about now; the client saves it with PATCH
router.post("/:id/title", async (req: Request, res: Response) => {
  try {
    const title = await suggestTitle(req.params.id as string);
    if (title) res.json({ title });
    else res.status(422).json({ error: "No messages to name this chat from" });
  } catch {
    res.status(502).json({ error: "Title model failed" });
  }
});

// The user has the chat on screen: its replies so far count as read on every device
router.post("/:id/seen", (req: Request, res: Response) => {
  if (markConversationSeen(req.params.id as string)) res.status(204).end();
  else res.status(404).json({ error: "Conversation not found" });
});

// Create empty conversation
router.post("/", (_req: Request, res: Response) => {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(conversations)
    .values({ id, createdAt: now, updatedAt: now })
    .run();
  res.status(201).json({ id, title: null, pinnedAgent: null, tags: [], pinned: false, createdAt: now, updatedAt: now });
});

// Update conversation (title)
router.patch("/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const existing = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const { title, tags, pinned, pinnedAgent } = req.body;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === "string"))) {
    res.status(400).json({ error: "tags must be a string array" });
    return;
  }
  if (pinnedAgent !== undefined && pinnedAgent !== null && typeof pinnedAgent !== "string") {
    res.status(400).json({ error: "pinnedAgent must be a string or null" });
    return;
  }
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (title !== undefined) updates.title = title;
  if (tags !== undefined) updates.tags = JSON.stringify(tags);
  if (pinned !== undefined) updates.pinned = pinned;
  if (pinnedAgent !== undefined) updates.pinnedAgent = pinnedAgent;

  db.update(conversations)
    .set(updates)
    .where(eq(conversations.id, id))
    .run();

  const updated = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get()!;
  res.json({ ...updated, tags: JSON.parse(updated.tags) as string[] });
});

// Delete conversation + messages
router.delete("/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const existing = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!existing) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  // First: its subagents would otherwise go on writing to a chat that no longer exists.
  closeConversationRuntime(id);
  db.delete(chatMessages)
    .where(eq(chatMessages.conversationId, id))
    .run();
  db.delete(conversations)
    .where(eq(conversations.id, id))
    .run();
  removeConversationWorktree(existing);
  res.status(204).send();
});

export default router;
