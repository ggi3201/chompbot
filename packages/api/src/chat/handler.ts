import { withChatReferences } from "./references.js";
import { publishLocalImages } from "../lib/chat-images.js";
import { db } from "../db/index.js";
import { generateTitleInBackground } from "./title.js";
import { channelTarget, resolveRun } from "../agents/run-target.js";
import type { TurnNotice } from "../agents/turn-notice.js";
import { agentSessions, conversations, chatMessages, skills } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { basename, join, resolve } from "path";
import { dispatchToAgent, type DispatchResult } from "../agents/dispatch.js";
import { buildHandoffPrompt, HANDOFF_COMMAND } from "../agents/handoff.js";
import { emit } from "../events/bus.js";
import { getResponseFormatInstruction, type DeliveryChannel } from "../channels/response-format.js";
import type { ExtractionInput } from "../memory/extractor.js";
import type { SessionReply } from "../mcp/state.js";
import type { RoutingDecision } from "@chomp/shared";
import type { AccessMode, AgentProvider } from "@chomp/shared";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./data/uploads";
mkdirSync(UPLOADS_DIR, { recursive: true });

const DATA_URL_RE = /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g;
const DATA_URL_SINGLE_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? ((mime.split("/")[1] ?? "bin").replace(/[^\w.]/g, "") || "bin");
}

function writeBufferToUpload(buffer: Buffer, mime: string): string {
  const name = `${randomUUID()}.${extForMime(mime)}`;
  writeFileSync(join(UPLOADS_DIR, name), buffer);
  return `/api/uploads/${name}`;
}

/** If `url` is a `data:<mime>;base64,...` URI, drain it to disk and return the
 *  new `/api/uploads/X` path. Otherwise return the url unchanged. */
function maybePersistDataUrl(url: string): string {
  const m = url.match(DATA_URL_SINGLE_RE);
  if (!m) return url;
  try {
    const buffer = Buffer.from(m[2], "base64");
    if (buffer.length === 0) return url;
    return writeBufferToUpload(buffer, m[1]);
  } catch {
    return url;
  }
}

/**
 * Replace inline `data:<mime>;base64,...` URIs in message content with on-disk
 * upload URLs. Keeps base64 blobs from ever reaching the agent prompts (and
 * blowing past ARG_MAX when spawning CLI runners).
 */
function persistInlineDataUrls(content: string): string {
  return content.replace(DATA_URL_RE, (match, mime: string, b64: string) => {
    try {
      const buffer = Buffer.from(b64, "base64");
      if (buffer.length === 0) return match;
      return writeBufferToUpload(buffer, mime);
    } catch {
      return match;
    }
  });
}

export interface ChatContext {
  conversationId: string;
  send: (data: object) => void;
  abortSignal?: AbortSignal;
  /** True once a "send now" replaced this request: its turn ends without a recovery line. */
  isSuperseded?: () => boolean;
}

export function shouldForwardAgentResponse(
  response: string | undefined,
  replyMessage?: SessionReply,
  options?: { suppressRunnerResponseAfterReply?: boolean },
): boolean {
  const responseText = response?.trim();
  if (!responseText) return false;
  if (options?.suppressRunnerResponseAfterReply && replyMessage) return false;
  return replyMessage?.content.trim() !== responseText;
}

/**
 * Persist and announce an agent turn's final text, unless chomp_reply already
 * delivered the same content (earlier progress replies must not suppress the
 * final). Returns the text that was forwarded, if any.
 */
export function deliverAgentResult(conversationId: string, routing: RoutingDecision, result: DispatchResult, ctx: ChatContext): string {
  const shouldForwardResponse = shouldForwardAgentResponse(result.response, result.replyMessage, {
    suppressRunnerResponseAfterReply: result.suppressRunnerResponseAfterReply,
  });
  const responseToForward = shouldForwardResponse ? publishLocalImages(result.response!.trim()) : "";

  const assistantMsgId = randomUUID();
  // Persist final runner text unless it is the same content already saved
  // by chomp_reply. Earlier progress replies must not suppress the final.
  if (shouldForwardResponse) {
    db.insert(chatMessages).values({
      id: assistantMsgId,
      conversationId,
      role: "assistant",
      content: responseToForward,
      routing: JSON.stringify(routing),
      agentUsed: result.agentUsed,
      turnId: result.turnId,
      createdAt: new Date().toISOString(),
    }).run();
  }

  db.update(conversations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, conversationId))
    .run();

  if (shouldForwardResponse) {
    emit({ type: "chat.message", conversationId, role: "assistant", content: responseToForward, agentUsed: result.agentUsed });
  }

  ctx.send({
    type: "done",
    messageId: shouldForwardResponse ? assistantMsgId : (result.replyMessage?.id ?? assistantMsgId),
    ...(shouldForwardResponse ? { content: responseToForward } : {}),
    ...(!shouldForwardResponse && result.replyMessage ? { replyMessage: result.replyMessage } : {}),
    agentUsed: result.agentUsed,
    turnId: result.turnId,
  });

  return responseToForward;
}

function getOrCreateConversation(conversationId?: string): string {
  if (conversationId) {
    const existing = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (existing) return existing.id;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, createdAt: now, updatedAt: now }).run();
  return id;
}

function isFirstUserMessage(conversationId: string): boolean {
  const count = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .all()
    .filter((m) => m.role === "user").length;
  return count === 0;
}

/**
 * The title until the model-written one arrives. A chat opened by /handoff
 * starts with the note, whose heading would make every such chat "# Handoff":
 * its goal line names the chat instead.
 */
export function placeholderTitle(content: string): string {
  const goal = /^#\s*Handoff\b/i.test(content.trim()) ? content.match(/^\W*Goal\W*:?\**\s*(.+)$/im)?.[1] : undefined;
  if (goal) return goal.replace(/[*`]+/g, "").trim().slice(0, 60);
  // A Telegram swipe-reply carries a quote; the chat is named after what you said.
  return content.replace(/^\[Replying to: "[\s\S]*?"\]\n\n/, "").slice(0, 60).replace(/\n/g, " ");
}

function autoTitle(conversationId: string, content: string) {
  const title = placeholderTitle(content);
  db.update(conversations)
    .set({ title, updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, conversationId))
    .run();
}

function getHistory(conversationId: string, limit = 20): Array<{ role: string; content: string }> {
  const messages = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .all()
    .reverse();

  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function getReflectionTranscript(conversationId: string, limit = 40): string {
  const messages = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .all()
    .reverse()
    .filter((m) => !m.content.trim().startsWith("/reflect-skills"));

  if (messages.length === 0) return "(No prior chat messages found.)";

  return messages
    .map((m) => {
      const who = m.agentUsed ? `${m.role} (${m.agentUsed})` : m.role;
      return `${who}: ${m.content.slice(0, 4000)}`;
    })
    .join("\n\n");
}

function getReflectionSessionContext(conversationId: string, limit = 3): string {
  const sessions = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, conversationId))
    .orderBy(desc(agentSessions.startedAt))
    .limit(limit)
    .all();

  if (sessions.length === 0) return "(No agent session records found.)";

  return sessions
    .map((s) => [
      `sessionId: ${s.sessionId}`,
      `agent: ${s.agentName} (${s.agentType})`,
      `status: ${s.status}`,
      s.label ? `label: ${s.label}` : undefined,
      s.model ? `model: ${s.model}` : undefined,
      s.startedAt ? `startedAt: ${s.startedAt}` : undefined,
      s.endedAt ? `endedAt: ${s.endedAt}` : undefined,
      typeof s.durationMs === "number" ? `durationMs: ${s.durationMs}` : undefined,
      s.logPath ? `logPath: ${s.logPath}` : undefined,
      s.userPrompt ? `userPrompt: ${s.userPrompt.slice(0, 2000)}` : undefined,
      s.error ? `error: ${s.error}` : undefined,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function buildReflectionPrompt(conversationId: string, userArg: string): string {
  const transcript = getReflectionTranscript(conversationId);
  const sessions = getReflectionSessionContext(conversationId);
  const focus = userArg ? `\nUser focus for this review: ${userArg}\n` : "";

  return `Review this Chomp conversation for durable skill or memory updates.${focus}

Your job:
- Look for reusable lessons, workflow fixes, preference updates, or skill instructions that would help future agents.
- If a relevant skill exists, call get_skills with its name before proposing or applying changes.
- Before saving memory, recall existing memories for duplicates. Update stale memories instead of creating duplicates.
- Save only durable cross-session facts, preferences, instructions, project context, or lessons. Do not save one-off task details.
- If a skill file should change but you cannot safely edit it from this environment, propose the exact patch in concise markdown.
- If there is nothing durable, say so plainly and do not invent homework.
- Keep the final response short: what changed or what you recommend, plus any skipped items.

Recent agent session records:
${sessions}

Conversation transcript:
${transcript}`;
}

export interface Attachment {
  url: string;
  name: string;
  mimeType: string;
}

function isImageAttachment(a: Attachment): boolean {
  return a.mimeType.startsWith("image/");
}

function markdownLabel(value: string): string {
  return value.replace(/[\[\]\n]/g, " ").trim() || "attachment";
}

/** Persisted form of the user message — images as markdown images, other files as markdown links. */
function buildContentWithAttachments(content: string, attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return content;
  const lines: string[] = [];
  for (const a of attachments) {
    const label = markdownLabel(a.name);
    lines.push(isImageAttachment(a) ? `![${label}](${a.url})` : `[${label}](${a.url})`);
  }
  const trailer = lines.join("\n");
  return content ? `${content}\n\n${trailer}` : trailer;
}

/** Text blurb describing non-image files so a vision-only LLM still knows they exist. */
function buildFileAnnotation(attachments?: Attachment[]): string {
  if (!attachments) return "";
  const files = attachments.filter((a) => !isImageAttachment(a));
  if (files.length === 0) return "";
  const lines = files.map((f) => `- ${f.name} (${f.mimeType}, ${f.url})`);
  return `\n\nAttached files (readable from disk at the /api/uploads path):\n${lines.join("\n")}`;
}

/** A CLI agent reads files from disk, and an /api/uploads link does not say where they are. */
function buildDiskAnnotation(attachments?: Attachment[]): string {
  const uploads = attachments?.filter((a) => a.url.startsWith("/api/uploads/")) ?? [];
  if (uploads.length === 0) return "";
  const lines = uploads.map((a) => `- ${a.name} (${a.mimeType}): ${resolve(UPLOADS_DIR, basename(a.url))}`);
  return `\n\nAttached files, on disk:\n${lines.join("\n")}`;
}

/** A message steered into a running turn: what the chat stores, and what the agent reads (with the files on disk). */
export function steeredMessage(content: string, attachmentsInput?: Attachment[] | string[]): { stored: string; forAgent: string } {
  const attachments = normalizeAttachments(attachmentsInput);
  const stored = buildContentWithAttachments(content, attachments);
  return { stored, forAgent: withChatReferences(stored) + buildDiskAnnotation(attachments) };
}

export interface ChatOptions {
  /** The provider to run on; absent means the one the model implies, then the channel default. */
  provider?: AgentProvider;
  model?: string;
  /** Reasoning-effort override for CLI agents. Validated per agent type in the
   *  dispatcher before reaching the runner. */
  effort?: string;
  /** A background turn's result delivery, kept with the turn so a resume can still send it. */
  notifyWhenDone?: TurnNotice;
  /** Claude fast mode / Codex priority tier, when the model supports it. */
  fast?: boolean;
  /** How much a CLI agent may do without asking. Defaults to full access. */
  access?: AccessMode;
  autonomy?: string;
  label?: string;
  soulId?: string;
  /** `/handoff`: the session writes a note for a new chat; `goal` is the new chat's task, if given. */
  handoff?: { goal: string };
  /** `/compact`: send the prompt to the CLI verbatim, without context or history around it. */
  compact?: boolean;
  /** A new chat's first message, when the chat continues another one's handoff. */
  handoffFrom?: string;
  /** A new chat's first message: the project its agents run in, from `listProjects()`. */
  projectPath?: string;
  /** With projectPath: false runs the agents in the repo checkout itself, not the chat's own worktree. */
  worktree?: boolean;
  channelContext?: string;
  /** Who wrote the message, when it isn't the user this Chomp belongs to (a channel shared with family). */
  author?: string;
  /**
   * Where the agent's output will be delivered. Canvas UI blocks only render
   * in the web chat; proactive sessions are delivered through Telegram/Discord/
   * notifications and must not emit `:::canvas` fences. Defaults to "web-chat".
   */
  deliveryChannel?: DeliveryChannel;
}

/**
 * Tells the agent someone else is writing. It goes in the message, not the
 * channel context: a resumed session keeps the system prompt of its first turn.
 */
function withAuthorNote(text: string, author?: string): string {
  if (!author) return text;
  return `[Written by ${author}, not by the user you belong to. Address ${author} by name. Their preferences are not the user's. Do not share the user's private matters, passwords or keys with them.]\n\n${text}`;
}

/** Callers that historically passed image URLs as `string[]` still work —
 * we normalize to Attachment[] here so the rest of the handler only sees one shape.
 * Any `data:` URIs (e.g. images downloaded by the Telegram handler) are drained
 * to disk so base64 never propagates downstream. */
function normalizeAttachments(input?: Attachment[] | string[]): Attachment[] | undefined {
  if (!input || input.length === 0) return undefined;
  const attachments: Attachment[] = typeof input[0] === "string"
    ? (input as string[]).map((url) => ({
        url,
        name: url.split("/").pop()?.split("?")[0] || "image",
        mimeType: "image/jpeg",
      }))
    : (input as Attachment[]);
  return attachments.map((a) => ({ ...a, url: maybePersistDataUrl(a.url) }));
}

/** Fire-and-forget: extract memories from the exchange. Never blocks or throws. */
/** Chats used from a channel carry its tag, so the sidebar can show and filter them. */
function tagConversation(conversationId: string, tag: string): void {
  const row = db.select({ tags: conversations.tags }).from(conversations).where(eq(conversations.id, conversationId)).get();
  const tags = JSON.parse(row?.tags ?? "[]") as string[];
  if (tags.includes(tag)) return;
  db.update(conversations).set({ tags: JSON.stringify([...tags, tag]) }).where(eq(conversations.id, conversationId)).run();
}

function extractMemoriesInBackground(turn: ExtractionInput): void {
  if (!turn.assistantResponse.trim()) return;
  import("../memory/extractor.js")
    .then(({ extractMemories }) => extractMemories(turn))
    .catch(() => {});
}

export async function handleChatMessage(
  content: string,
  ctx: ChatContext,
  attachmentsInput?: Attachment[] | string[],
  options?: ChatOptions,
) {
  const conversationId = getOrCreateConversation(ctx.conversationId);
  // Update ctx so dispatch/runners see the real conversation ID
  ctx.conversationId = conversationId;
  const now = new Date().toISOString();

  // Auto-title on first user message
  const firstMsg = isFirstUserMessage(conversationId);

  const attachments = normalizeAttachments(attachmentsInput);

  // Drain any inline base64 data URLs to disk before they reach the runners.
  content = persistInlineDataUrls(content);

  // Build content with embedded image markdown + file links
  // The label stays in the stored text, so history and the web chat show who said what.
  const fullContent = buildContentWithAttachments(options?.author ? `**${options.author}:** ${content}` : content, attachments);
  const imageUrls = attachments?.filter(isImageAttachment).map((a) => a.url);
  const fileAnnotation = buildFileAnnotation(attachments);

  // Save user message
  const userMsgId = randomUUID();
  const source = options?.deliveryChannel === "telegram" || options?.deliveryChannel === "discord" ? options.deliveryChannel : null;
  db.insert(chatMessages).values({
    id: userMsgId,
    conversationId,
    role: "user",
    content: fullContent,
    source,
    createdAt: now,
  }).run();
  // The sidebar's "last active" time should move when the user speaks, not only when the reply lands.
  db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversationId)).run();
  if (source) tagConversation(conversationId, source);

  emit({ type: "chat.message", conversationId, role: "user", content: fullContent });

  if (firstMsg && options?.handoffFrom && options.handoffFrom !== conversationId) {
    const parent = db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, options.handoffFrom)).get();
    if (parent) db.update(conversations).set({ parentId: parent.id, parentKind: "handoff" }).where(eq(conversations.id, conversationId)).run();
  }

  // Only the first message sets it: a native session stays in the directory it started in.
  if (firstMsg && options?.projectPath) {
    db.update(conversations).set({ projectPath: options.projectPath, useWorktree: options.worktree !== false }).where(eq(conversations.id, conversationId)).run();
  }

  if (firstMsg) {
    autoTitle(conversationId, content);
    generateTitleInBackground(conversationId, content, resolveRun({}, options ?? {}, channelTarget(options?.deliveryChannel)).provider);
  }

  ctx.send({ type: "conversation", conversationId });

  // ── /handoff: this session writes the note a new chat starts from ──
  if (options?.handoff || content === HANDOFF_COMMAND || content.startsWith(`${HANDOFF_COMMAND} `)) {
    const goal = options?.handoff?.goal ?? content.slice(HANDOFF_COMMAND.length).trim();
    const routing: RoutingDecision = { action: "delegate", prompt: buildHandoffPrompt(goal), reason: "handoff" };
    try {
      ctx.send({ type: "status", status: "agent_working" });
      const result = await dispatchToAgent(routing, ctx, options);
      const note = deliverAgentResult(conversationId, routing, result, ctx) || result.replyMessage?.content || "";
      if (note.trim()) ctx.send({ type: "handoff", conversationId, content: note.trim() });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[handoff] Error:", err);
      const userNotified = !!(err as { userNotified?: boolean } | null)?.userNotified;
      if (!userNotified) {
        db.insert(chatMessages).values({
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: `Error writing the handoff: ${errorMsg}`,
          createdAt: new Date().toISOString(),
        }).run();
      }
      ctx.send({ type: "error", error: errorMsg, ...(userNotified ? { recovered: true } : {}) });
    }
    return;
  }

  // ── /reload-skills, /reload-plugins: Claude Code reads both at start, so restart this chat's process ──
  const reload = content.trim();
  if (reload === "/reload-skills" || reload === "/reload-plugins") {
    const { activeRuntime, closeConversationRuntime } = await import("../agents/runtime/pool.js");
    let text: string;
    if (activeRuntime(conversationId)?.busy) {
      text = "An agent is still working in this chat. Try again when it is done.";
    } else {
      try {
        text = reload === "/reload-skills" ? await reloadSkills() : await reloadPlugins();
        closeConversationRuntime(conversationId);
        text += "\n\nThe next message in this chat starts with them, in the same conversation.";
      } catch (err) {
        text = `Could not reload: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const replyId = randomUUID();
    db.insert(chatMessages).values({ id: replyId, conversationId, role: "assistant", content: text, createdAt: new Date().toISOString() }).run();
    ctx.send({ type: "chunk", content: text });
    ctx.send({ type: "done", messageId: replyId });
    return;
  }

  // ── /compact: the live session shrinks its own context; the runner reports what it freed ──
  if (content.trim() === "/compact") {
    const routing: RoutingDecision = { action: "delegate", prompt: "/compact", reason: "compact" };
    try {
      ctx.send({ type: "status", status: "agent_working" });
      const result = await dispatchToAgent(routing, ctx, { ...options, compact: true });
      deliverAgentResult(conversationId, routing, result, ctx);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[compact] Error:", err);
      const userNotified = !!(err as { userNotified?: boolean } | null)?.userNotified;
      if (!userNotified) {
        db.insert(chatMessages).values({
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: `Could not compact: ${errorMsg}`,
          createdAt: new Date().toISOString(),
        }).run();
      }
      ctx.send({ type: "error", error: errorMsg, ...(userNotified ? { recovered: true } : {}) });
    }
    return;
  }

  // ── /reflect-skills command interception (before generic skill slash commands) ──
  if (content.startsWith("/reflect-skills")) {
    const userArg = content.slice("/reflect-skills".length).trim();
    const reflectionPrompt = buildReflectionPrompt(conversationId, userArg);

    try {
      ctx.send({ type: "status", status: "agent_working" });
      const result = await dispatchToAgent(
        {
          action: "delegate",
          prompt: reflectionPrompt,
          reason: "reflect-skills",
        },
        ctx,
        options,
      );

      const assistantMsgId = randomUUID();
      if (result.response?.trim() && !result.alreadySent) {
        db.insert(chatMessages).values({
          id: assistantMsgId,
          conversationId,
          role: "assistant",
          content: publishLocalImages(result.response),
          agentUsed: result.agentUsed,
          turnId: result.turnId,
          createdAt: new Date().toISOString(),
        }).run();
      }

      db.update(conversations)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, conversationId))
        .run();

      ctx.send({
        type: "done",
        messageId: result.replyMessage?.id ?? assistantMsgId,
        ...(result.alreadySent ? {} : (result.response?.trim() ? { content: result.response } : {})),
        ...(result.replyMessage ? { replyMessage: result.replyMessage } : {}),
        agentUsed: result.agentUsed,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[reflect-skills] Error:", err);
      const userNotified = !!(err as { userNotified?: boolean } | null)?.userNotified;
      if (!userNotified) {
        db.insert(chatMessages).values({
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: `Error running skill review: ${errorMsg}`,
          createdAt: new Date().toISOString(),
        }).run();
      }
      ctx.send({ type: "error", error: errorMsg, ...(userNotified ? { recovered: true } : {}) });
    }
    return;
  }

  // ── /skill-name command interception ──
  if (content.startsWith("/")) {
    const spaceIdx = content.indexOf(" ");
    const slug = (spaceIdx > 0 ? content.slice(1, spaceIdx) : content.slice(1)).toLowerCase();
    const skillArg = spaceIdx > 0 ? content.slice(spaceIdx + 1).trim() : "";

    // Match slug against enabled skills
    const enabledSkills = db.select().from(skills).all().filter((s) => s.enabled);
    const matchedSkill = enabledSkills.find((s) => {
      const skillSlug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return skillSlug === slug;
    });

    if (matchedSkill) {
      const skillPrompt = skillArg
        ? `Use the following skill instructions:\n\n${matchedSkill.content}\n\nUser request: ${skillArg}`
        : `Use the following skill instructions:\n\n${matchedSkill.content}`;

      try {
        const result = await dispatchToAgent(
          { action: "delegate" as const, prompt: skillPrompt, reason: `skill: ${matchedSkill.name}` },
          ctx,
          options,
        );

        const assistantMsgId = randomUUID();
        if (result.response?.trim() && !result.alreadySent) {
          db.insert(chatMessages).values({
            id: assistantMsgId,
            conversationId,
            role: "assistant",
            content: publishLocalImages(result.response),
            agentUsed: result.agentUsed,
            turnId: result.turnId,
            createdAt: new Date().toISOString(),
          }).run();
        }

        db.update(conversations)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, conversationId))
          .run();

        ctx.send({
          type: "done",
          messageId: assistantMsgId,
          ...(result.alreadySent ? {} : (result.response?.trim() ? { content: result.response } : {})),
          agentUsed: result.agentUsed,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[chat] Skill ${matchedSkill.name} error:`, err);
        const userNotified = !!(err as { userNotified?: boolean } | null)?.userNotified;
        if (!userNotified) {
          db.insert(chatMessages).values({
            id: randomUUID(),
            conversationId,
            role: "assistant",
            content: `Error running skill ${matchedSkill.name}: ${errorMsg}`,
            createdAt: new Date().toISOString(),
          }).run();
        }
        ctx.send({ type: "error", error: errorMsg, ...(userNotified ? { recovered: true } : {}) });
      }
      return;
    }
  }

  const history = getHistory(conversationId);

  try {
    const { routeMessage } = await import("../ollama/triage.js");

    ctx.send({ type: "status", status: "routing" });

    const routing = routeMessage(content);
    console.log("[chat] Routing result:", JSON.stringify(routing));

    // Delegate to the appropriate agent — include recent conversation history
    // Always include the previous message in full, then fill remaining budget (2000 chars) with older messages
    const HISTORY_BUDGET = 2000;
    const historyMessages = history.slice(-10);
    let recentHistory = "";
    if (historyMessages.length > 0) {
      const prev = historyMessages[historyMessages.length - 1];
      const prevLine = `${prev.role}: ${prev.content}`;
      const older = historyMessages.slice(0, -1);
      const olderLines: string[] = [];
      let olderChars = 0;
      for (let i = older.length - 1; i >= 0; i--) {
        const line = `${older[i].role}: ${older[i].content.slice(0, 500)}`;
        if (olderChars + line.length > HISTORY_BUDGET) break;
        olderLines.unshift(line);
        olderChars += line.length;
      }
      recentHistory = [...olderLines, prevLine].join("\n");
    }
    // Ensure attachments (images + files) reach the delegate agent too.
    // routing.prompt comes from routeMessage(content) which operates on plain text;
    // we append the attachment summary so Claude Code / Codex / etc. see what's uploaded.
    const baseRequest = withAuthorNote(withChatReferences(routing.prompt ?? content), options?.author);
    const requestWithAttachments = attachments && attachments.length > 0
      ? buildContentWithAttachments(baseRequest, attachments) + buildDiskAnnotation(attachments)
      : baseRequest;
    const enrichedRouting = {
      ...routing,
      prompt: recentHistory
        ? `Recent conversation:\n${recentHistory}\n\nCurrent request: ${requestWithAttachments}`
        : requestWithAttachments,
    };
    const result = await dispatchToAgent(enrichedRouting, ctx, options);
    const responseToForward = deliverAgentResult(conversationId, routing, result, ctx);

    // Agent turns answer via chomp_reply, so the last reply is the assistant side of the exchange.
    if (!options?.author) extractMemoriesInBackground({ userMessage: content, assistantResponse: responseToForward || result.replyMessage?.content || "", recentTurns: history.slice(-5, -1), conversationId, messageId: userMsgId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error("[chat] Error:", err);

    // When dispatch already surfaced a human-facing message for this failure
    // (a flushed fallback reply, or an intermediate reply that already landed),
    // don't pile a raw `Error: <internal>` assistant message on top of it — that
    // string is the very noise that used to replace the real answer on killed
    // turns. Still signal the client so the working spinner resolves.
    const userNotified = !!(err as { userNotified?: boolean } | null)?.userNotified;
    if (!userNotified) {
      // Save error as assistant message so it persists in history
      db.insert(chatMessages).values({
        id: randomUUID(),
        conversationId,
        role: "assistant",
        content: `Error: ${errorMsg}`,
        createdAt: new Date().toISOString(),
      }).run();
    }

    ctx.send({ type: "error", error: errorMsg, ...(userNotified ? { recovered: true } : {}) });
  }
}

/** Skills from ~/.claude/skills into Chomp, and Chomp's skills out to Codex, as at startup. */
async function reloadSkills(): Promise<string> {
  const [{ importSkills }, { syncSkillsToCodex }] = await Promise.all([import("../sync/import.js"), import("../sync/mcp.js")]);
  const result = importSkills();
  syncSkillsToCodex();
  return `Skills reloaded: ${result.imported} new, ${result.updated} updated.`;
}

/** What Claude Code has switched on, for the reply; the restart itself picks them up. */
async function reloadPlugins(): Promise<string> {
  const { listPlugins } = await import("../routes/plugins.js");
  const on = (await listPlugins()).filter((p) => p.enabled).map((p) => p.name);
  return on.length ? `Plugins reloaded. On: ${on.join(", ")}.` : "Plugins reloaded. None are switched on.";
}
