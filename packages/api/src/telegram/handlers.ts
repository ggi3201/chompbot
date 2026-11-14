import { InlineKeyboard, type Context } from "grammy";
import type { Message } from "grammy/types";
import { db } from "../db/index.js";
import { schedules, souls, memories, conversations, settings, proactiveRules, webhooks, chatMessages } from "../db/schema.js";
import { eq, desc, like } from "drizzle-orm";
import { randomUUID } from "crypto";
import { handleChatMessage, type ChatContext } from "../chat/handler.js";
import { answerPendingQuestion } from "../mcp/pending-questions.js";
import { resolvePendingAction } from "../notifications/pending-actions.js";
import { onAskUser, onReply } from "../mcp/server.js";
import { sessionConversations } from "../mcp/state.js";
import { getLinkedChatId, sendTelegramMessage, sendTelegramQuestion } from "./bot.js";
import { getActiveSessions, getSessionHistory, killSession } from "../agents/registry.js";
import { markdownToTelegramHtml } from "./format.js";
import { renderCanvasForChannel } from "../lib/canvas-render.js";
import { trackSentMessage, getConversationForTelegramMsg, getLastTelegramMsgForConv, chatLabelHtml, shortChatTitle } from "./tracking.js";
import { triggerRule } from "../proactive/engine.js";
import { getDelegatedPrompt, renderTelegramHelp } from "../channels/command-catalog.js";
import { channelTargetLabel } from "../agents/run-target.js";

/** Escape HTML special characters for Telegram */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Send a reply with HTML parse mode, falling back to plain text */
function replyHtml(ctx: Context, html: string): Promise<Message.TextMessage> {
  return ctx.reply(html, { parse_mode: "HTML" })
    .catch(() => ctx.reply(html.replace(/<[^>]+>/g, "")));
}

// ── Inline keyboard pattern detection ───────────────────────────

interface ButtonDef {
  text: string;
  /** Value sent back as callback_data — max 64 bytes */
  value: string;
}

/**
 * Detect common question patterns and return button definitions.
 * Returns null if the question should be sent as plain text.
 */
export function detectQuestionPattern(question: string): ButtonDef[] | null {
  // yes/no
  if (/\byes\s*\/\s*no\b|\bno\s*\/\s*yes\b/i.test(question)) {
    return [
      { text: "✅ Yes", value: "yes" },
      { text: "❌ No", value: "no" },
    ];
  }

  // approve/reject
  if (/\bapprove\s*\/\s*reject\b|\breject\s*\/\s*approve\b/i.test(question)) {
    return [
      { text: "✅ Approve", value: "approve" },
      { text: "❌ Reject", value: "reject" },
    ];
  }

  // Numbered options: "1. Foo\n2. Bar\n3. Baz"
  const numbered = [...question.matchAll(/^\s*(\d+)[.)]\s+(.+?)$/gm)];
  if (numbered.length >= 2 && numbered.length <= 6) {
    return numbered.map((m) => {
      const label = m[2].trim();
      return {
        text: `${m[1]}. ${label.length > 28 ? label.slice(0, 27) + "…" : label}`,
        value: m[1],
      };
    });
  }

  // Letter options: "(a) Foo\n(b) Bar" or "a) Foo\nb) Bar"
  const lettered = [...question.matchAll(/^\s*\(?([a-f])\)?\s+(.+?)$/gm)];
  if (lettered.length >= 2 && lettered.length <= 6) {
    return lettered.map((m) => {
      const label = m[2].trim();
      return {
        text: `${m[1].toUpperCase()}. ${label.length > 28 ? label.slice(0, 27) + "…" : label}`,
        value: m[1].toLowerCase(),
      };
    });
  }

  return null;
}

/**
 * Build a Grammy InlineKeyboard from button definitions.
 * Yes/No-style buttons share one row; options each get their own row.
 */
function buildInlineKeyboard(buttons: ButtonDef[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (buttons.length === 2) {
    // Side-by-side for binary choices
    kb.text(buttons[0].text, buttons[0].value.slice(0, 64));
    kb.text(buttons[1].text, buttons[1].value.slice(0, 64));
  } else {
    // One button per row for multi-option lists
    for (const b of buttons) {
      kb.text(b.text, b.value.slice(0, 64)).row();
    }
  }
  return kb;
}

// ── Telegram state ──────────────────────────────────────────────

/** The question an agent is waiting on. A message aimed at its chat is the answer. */
let pendingQuestion: { sessionId: string; conversationId: string } | null = null;

/** The chat plain messages go to. Moves when you swipe-reply, pick in /chats or /new. */
let telegramConversationId: string | null = null;

/**
 * Per-run reply bookkeeping, keyed by the agent sessionId.
 *
 * Previously this lived in module-level globals (one `activeTelegramCtx`, one
 * `liveRepliesSent`, etc.). Because the Telegram chat is a single persistent
 * conversation, overlapping messages — or a proactive run landing mid-chat —
 * clobbered each other's state, dropping or misrouting replies. Worse,
 * `isTelegramSession` claims every conversation-less background session, so a
 * background reply could flip the active run's `liveRepliesSent` and poison its
 * `done` handler.
 *
 * Keying by sessionId isolates each run. The map is populated when a run's
 * `sessionId` event arrives (before the agent produces any reply) and cleared on
 * done/error; the global onReply/onAskUser callbacks look the run up here.
 */
interface TelegramRunState {
  ctx: Context;
  conversationId: string;
  /** Live chomp_reply messages sent during this run. */
  collectedReplies: string[];
  liveRepliesSent: boolean;
  liveReplyFailed: boolean;
  liveReplyChain: Promise<void>;
}

const telegramRuns = new Map<string, TelegramRunState>();

function createTelegramRunState(ctx: Context, conversationId: string): TelegramRunState {
  return {
    ctx,
    conversationId,
    collectedReplies: [],
    liveRepliesSent: false,
    liveReplyFailed: false,
    liveReplyChain: Promise.resolve(),
  };
}

// ── Chunk buffering ─────────────────────────────────────────────

const MAX_TELEGRAM_MSG_LENGTH = 4000;

// ── Conversation management ─────────────────────────────────────

/** A plain message after this long starts a new chat: a one-word "Test" must not get answered from a months-old thread. */
const TELEGRAM_CHAT_IDLE_MS = 6 * 60 * 60 * 1000;

function currentTelegramConversationId(): string | null {
  telegramConversationId ??= db.select().from(settings).where(eq(settings.key, "telegram_conversation_id")).get()?.value || null;
  return telegramConversationId;
}

function setCurrentTelegramConversation(id: string | null): void {
  telegramConversationId = id;
  upsertSetting("telegram_conversation_id", id ?? "");
}

function createTelegramConversation(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title: "Telegram", createdAt: now, updatedAt: now }).run();
  setCurrentTelegramConversation(id);
  return id;
}

function getOrCreateTelegramConversation(): string {
  const id = currentTelegramConversationId();
  const existing = id ? db.select().from(conversations).where(eq(conversations.id, id)).get() : undefined;
  if (existing && Date.now() - Date.parse(existing.updatedAt) < TELEGRAM_CHAT_IDLE_MS) return existing.id;
  return createTelegramConversation();
}

type RepliedTo = { message_id: number; from?: { is_bot: boolean } };

/** The existing chat a message is aimed at: the swiped bot message's chat, otherwise the current one. */
export function targetTelegramConversation(repliedTo?: RepliedTo): string | undefined {
  if (!repliedTo?.from?.is_bot) return currentTelegramConversationId() ?? undefined;
  const linked = getConversationForTelegramMsg(repliedTo.message_id);
  return linked && db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, linked)).get()?.id;
}

/** The chat to run an incoming message in, creating one when it has none. */
export function resolveTelegramConversation(repliedTo?: RepliedTo): string {
  if (!repliedTo?.from?.is_bot) return getOrCreateTelegramConversation();
  // A swiped message with no chat (a plain notification, /status output) gets its
  // own: the reply is about that message, not whatever thread happens to be current.
  return targetTelegramConversation(repliedTo) ?? createTelegramConversation();
}

/** Tell the agent's question to Telegram and wait for the answer in that chat. */
function askInTelegram(sessionId: string, conversationId: string, question: string): void {
  pendingQuestion = { sessionId, conversationId };
  const buttons = detectQuestionPattern(question);
  sendTelegramQuestion(question, conversationId, buttons ? buildInlineKeyboard(buttons) : undefined)
    .catch((err) => console.error("[telegram] Failed to send question:", err));
}

/** Send an agent reply headed with its chat, linking every part for swipe-replies. */
async function sendChatReply(ctx: Context, conversationId: string, content: string): Promise<void> {
  const html = `${chatLabelHtml(conversationId)}\n\n${markdownToTelegramHtml(renderCanvasForChannel(content, "telegram"))}`;
  for (const part of splitMessage(html)) {
    const sent = await replyHtml(ctx, part);
    if (sent?.message_id) trackSentMessage(sent.message_id, conversationId);
  }
}

/** The /chats picker: recent chats as buttons, current one ticked. */
async function showChatPicker(ctx: Context): Promise<void> {
  const current = currentTelegramConversationId();
  const recent = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(8).all();
  if (recent.length === 0) {
    await ctx.reply("No chats yet. Just send a message.");
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const c of recent) {
    keyboard.text(`${c.id === current ? "✓ " : ""}${shortChatTitle(c.title)}`, `chat:${c.id}`).row();
  }
  const heading = current ? `Now in ${chatLabelHtml(current)}\n\n` : "";
  await ctx.reply(`${heading}Tap a chat to continue it, or /new for a fresh one.`, { parse_mode: "HTML", reply_markup: keyboard });
}

// ── MCP callbacks for Telegram ──────────────────────────────────

/**
 * Register Telegram-specific callbacks for ask_user and reply.
 * These fire when an agent working on a Telegram conversation sends messages.
 */
/** Returns true if the given sessionId originated from the Telegram conversation */
function isTelegramSession(sessionId: string): boolean {
  const convId = sessionConversations.get(sessionId);
  // No conversation mapping → background/scheduled task of unknown origin — don't
  // claim it. Claiming unmapped sessions caused replies from background runs that
  // originated in other channels (e.g. the web UI) to be hijacked to Telegram.
  // Matches Discord's conservative behavior; proactive Telegram delivery goes
  // through the notification router with explicit channels, not this callback.
  if (!convId) return false;
  return convId === currentTelegramConversationId();
}

export function registerTelegramCallbacks() {
  onAskUser((sessionId, question) => {
    const conversationId = telegramRuns.get(sessionId)?.conversationId
      ?? (isTelegramSession(sessionId) ? sessionConversations.get(sessionId) : undefined);
    if (conversationId) askInTelegram(sessionId, conversationId, question);
  });

  onReply((sessionId, reply) => {
    const run = telegramRuns.get(sessionId);

    if (run) {
      run.liveRepliesSent = true;
      run.collectedReplies.push(reply.content);
      const { ctx, conversationId } = run;
      run.liveReplyChain = run.liveReplyChain.then(() => sendChatReply(ctx, conversationId, reply.content)).catch((err) => {
        run.liveReplyFailed = true;
        console.error("[telegram] Failed to send live reply:", err);
      });
      return;
    }

    // No active run for this session — background/proactive session.
    // Forward as a notification threaded under the conversation's last message,
    // but only when the session genuinely belongs to the Telegram conversation.
    const convId = sessionConversations.get(sessionId);
    if (isTelegramSession(sessionId) && convId) {
      const replyTo = getLastTelegramMsgForConv(convId);
      sendTelegramMessage(reply.content, { conversationId: convId, ...(replyTo ? { replyToMessageId: replyTo } : {}) })
        .catch((err) => console.error("[telegram] Failed to forward reply:", err));
    }
  });
}

// ── Chat context adapter ────────────────────────────────────────

function createTelegramChatContext(ctx: Context, overrideConversationId?: string): ChatContext {
  const conversationId = overrideConversationId ?? getOrCreateTelegramConversation();
  // The chat you last talked in is the one your next plain message continues.
  if (conversationId !== telegramConversationId) setCurrentTelegramConversation(conversationId);
  const runState = createTelegramRunState(ctx, conversationId);
  // Buffer for streamed chunks (direct, non-delegated responses).
  let fullResponse = "";
  // Populated from the `sessionId` event so this run can be located by the
  // global onReply/onAskUser callbacks, and cleared on done/error.
  let sessionId: string | null = null;

  return {
    conversationId,
    send: (data: object) => {
      const d = data as Record<string, unknown>;
      const type = d.type as string;

      switch (type) {
        case "chunk":
          // Buffer chunks — we'll send the full response on "done"
          fullResponse += d.content as string;
          break;

        case "routing":
          // Routing info logged server-side only — no need to message the user
          break;

        case "done": {
          // Active chomp_reply messages are sent live. The done handler only
          // sends a final body for streamed/direct responses, failed live sends,
          // or agents that never called chomp_reply.
          let content: string;
          if (runState.liveRepliesSent && runState.liveReplyFailed && runState.collectedReplies.length > 0) {
            content = runState.collectedReplies.join("\n\n");
          } else if ((d.content as string) || fullResponse) {
            content = (d.content as string) || fullResponse;
          } else if (!runState.liveRepliesSent) {
            const msgId = d.messageId as string | undefined;
            const dbMsg = msgId ? db.select().from(chatMessages).where(eq(chatMessages.id, msgId)).get() : null;
            content = dbMsg?.content ?? "";
          } else {
            content = "";
          }
          if (content) {
            sendChatReply(ctx, conversationId, content)
              .catch((err) => console.error("[telegram] Failed to send done:", err));
          }
          if (sessionId) telegramRuns.delete(sessionId);
          break;
        }

        case "question":
          askInTelegram(d.sessionId as string, conversationId, String(d.question));
          break;

        case "error":
          ctx.reply(`Error: ${d.error}`)
            .catch((err) => console.error("[telegram] Failed to send error:", err));
          if (sessionId) telegramRuns.delete(sessionId);
          break;

        case "status":
          // Could send a typing indicator or brief status
          if (d.status === "triaging" || d.status === "routing") {
            ctx.replyWithChatAction("typing")
              .catch(() => {}); // Best-effort
          }
          break;

        case "sessionId":
          // Register this run so onReply/onAskUser can locate it by sessionId.
          sessionId = d.sessionId as string;
          telegramRuns.set(sessionId, runState);
          break;

        // Ignore web-only message types
        case "conversation":
        case "meta":
        case "agent_progress":
          break;
      }
    },
  };
}

// ── Message splitting for Telegram's 4096 char limit ────────────

function splitMessage(text: string, maxLen = MAX_TELEGRAM_MSG_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      // No good newline break — split at space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good break point — hard split
      splitIdx = maxLen;
    }

    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return parts;
}

// ── Duration parsing ─────────────────────────────────────────────

/** Parse "1h", "30m", "2h30m" → milliseconds, or null if invalid */
function parseDurationMs(s: string): number | null {
  const h = parseInt(s.match(/(\d+)h/)?.[1] ?? "0", 10);
  const m = parseInt(s.match(/(\d+)m/)?.[1] ?? "0", 10);
  const totalMs = (h * 60 + m) * 60 * 1000;
  return totalMs > 0 ? totalMs : null;
}

// ── Chat delegation helper ────────────────────────────────────────

/** Route a crafted prompt through the full chat pipeline (AI agent) */
async function delegateToChat(ctx: Context, prompt: string): Promise<void> {
  try {
    const chatCtx = createTelegramChatContext(ctx);
    await handleChatMessage(prompt, chatCtx, undefined, {
      channelContext: getTelegramLocationContext(),
      deliveryChannel: "telegram",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(`Error: ${msg}`);
  }
}

// ── Settings helpers ──────────────────────────────────────────────

function upsertSetting(key: string, value: string): void {
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value }).run();
  }
}

function getTelegramLocationContext(): string | undefined {
  const row = db.select().from(settings).where(eq(settings.key, "telegram_last_location_context")).get();
  return row?.value || undefined;
}

function formatTelegramLocationContext(location: {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  heading?: number;
  live_period?: number;
  proximity_alert_radius?: number;
}): string {
  const parts = [
    `Telegram shared location: ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`,
  ];

  if (typeof location.horizontal_accuracy === "number") {
    parts.push(`Accuracy: about ${Math.round(location.horizontal_accuracy)}m`);
  }
  if (typeof location.heading === "number") {
    parts.push(`Heading: ${location.heading}deg`);
  }
  if (typeof location.live_period === "number") {
    parts.push(`Live location window: ${location.live_period}s`);
  }
  if (typeof location.proximity_alert_radius === "number") {
    parts.push(`Proximity alert radius: ${location.proximity_alert_radius}m`);
  }

  parts.push(`Captured at: ${new Date().toISOString()}`);
  return parts.join("\n");
}

// ── Public handlers ─────────────────────────────────────────────

// ── Attachment helpers ─────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".html", ".htm", ".css", ".js", ".ts", ".json", ".csv", ".xml", ".yaml", ".yml", ".toml", ".py", ".sh", ".sql", ".log", ".tsx", ".jsx", ".svelte", ".vue"]);
const MAX_TEXT_FILE_SIZE = 100_000; // 100 KB

/** Get the Telegram Bot API file download URL (internal — never store, contains bot token) */
function getTelegramFileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

/** Download a Telegram file and return as a base64 data URI (strips the token-bearing URL) */
async function downloadTelegramFile(ctx: Context, fileId: string, mimeType = "image/jpeg"): Promise<string | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = getTelegramFileUrl(ctx.api.token, file.file_path);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${mimeType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Download a Telegram file and return as text content */
async function downloadTelegramFileAsText(ctx: Context, fileId: string): Promise<string | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = getTelegramFileUrl(ctx.api.token, file.file_path);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Extract images and text file context from a Telegram message */
async function extractTelegramAttachments(ctx: Context): Promise<{ images: string[]; fileContext: string; caption: string }> {
  const images: string[] = [];
  const fileContextParts: string[] = [];
  const caption = ctx.message?.caption ?? "";

  // Photos — pick the largest resolution, download as base64 to avoid leaking bot token
  const photos = ctx.message?.photo;
  if (photos && photos.length > 0) {
    const largest = photos[photos.length - 1];
    const dataUri = await downloadTelegramFile(ctx, largest.file_id);
    if (dataUri) images.push(dataUri);
  }

  // Documents — text files get embedded as context
  const doc = ctx.message?.document;
  if (doc) {
    const name = doc.file_name ?? "file";
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
    const mimeType = doc.mime_type ?? "";

    if (mimeType.startsWith("image/")) {
      const dataUri = await downloadTelegramFile(ctx, doc.file_id, mimeType);
      if (dataUri) images.push(dataUri);
    } else if (TEXT_EXTENSIONS.has(ext) && (doc.file_size ?? 0) <= MAX_TEXT_FILE_SIZE) {
      const content = await downloadTelegramFileAsText(ctx, doc.file_id);
      if (content !== null) {
        const escaped = content.replaceAll("```", "\\`\\`\\`");
        fileContextParts.push(`Attached file: ${name} (${doc.file_size} bytes)\n\`\`\`\n${escaped}\n\`\`\``);
      } else {
        fileContextParts.push(`Attached file: ${name} (failed to download)`);
      }
    } else if (TEXT_EXTENSIONS.has(ext) && (doc.file_size ?? 0) > MAX_TEXT_FILE_SIZE) {
      fileContextParts.push(`Attached file: ${name} (${Math.round((doc.file_size ?? 0) / 1024)} KB — too large to embed, skipped)`);
    }
  }

  return { images, fileContext: fileContextParts.join("\n\n"), caption };
}

/** A voice message as text, or null when it could not be understood. */
async function transcribeTelegramVoice(ctx: Context, fileId: string, mimeType: string): Promise<string | null> {
  const dataUri = await downloadTelegramFile(ctx, fileId, mimeType);
  if (!dataUri) return null;
  try {
    const { transcribeAudio } = await import("../routes/voice.js");
    return (await transcribeAudio(Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"), mimeType)).trim() || null;
  } catch (err) {
    console.error("[telegram] Voice transcription failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Handle a regular text message from Telegram */
export async function handleTelegramMessage(ctx: Context) {
  const chatId = getLinkedChatId();
  if (chatId && ctx.chat?.id !== chatId) {
    await ctx.reply("This chat is not linked to Chomp. Send /start to link.");
    return;
  }

  if (ctx.message?.location) {
    upsertSetting("telegram_last_location_context", formatTelegramLocationContext(ctx.message.location));
    await ctx.reply("Location saved. I’ll use it as Telegram context for weather, nearby places, and travel questions.");
    return;
  }

  // Extract text — could be .text (text message) or .caption (photo/document message)
  let rawText = ctx.message?.text ?? "";

  const voice = ctx.message?.voice;
  if (voice) {
    const spoken = await transcribeTelegramVoice(ctx, voice.file_id, voice.mime_type ?? "audio/ogg");
    if (!spoken) {
      await ctx.reply("I couldn't make out that voice message, so nothing was sent on. Try again, or type it.");
      return;
    }
    // Echoed because an agent acts on this text, so a mishearing has to be visible.
    await ctx.reply(`Heard: ${spoken.slice(0, 3500)}`);
    rawText = spoken;
  }

  // Extract attachments (images, text files, captions)
  const { images, fileContext, caption } = await extractTelegramAttachments(ctx);

  // Build the full text: raw text or caption + any embedded file content
  const baseText = rawText || caption;
  const text = fileContext ? (baseText ? `${baseText}\n\n${fileContext}` : fileContext) : baseText;
  if (!text && images.length === 0) return;

  const repliedTo = ctx.message?.reply_to_message;

  // A message aimed at the waiting question's chat is its answer (raw text only, not file context)
  const question = pendingQuestion;
  if (question && baseText && targetTelegramConversation(repliedTo) === question.conversationId) {
    pendingQuestion = null;
    const answered = answerPendingQuestion(question.sessionId, baseText);
    if (answered) {
      const sent = await replyHtml(ctx, `Answer sent to ${chatLabelHtml(question.conversationId)}`);
      trackSentMessage(sent.message_id, question.conversationId);
      return;
    }
    // If the question expired, fall through to normal handling
  }

  let replyContext = "";
  // Extract the text of the message being replied to so the agent has context
  const repliedToText = repliedTo?.text || repliedTo?.caption;
  if (repliedToText) {
    const truncated = repliedToText.length > 500 ? repliedToText.slice(0, 500) + "…" : repliedToText;
    replyContext = `[Replying to: "${truncated}"]\n\n`;
  }

  try {
    const chatCtx = createTelegramChatContext(ctx, resolveTelegramConversation(repliedTo));
    await handleChatMessage(replyContext + (text || ""), chatCtx, images.length > 0 ? images : undefined, {
      channelContext: getTelegramLocationContext(),
      deliveryChannel: "telegram",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await ctx.reply(`Error: ${msg}`);
  }
}

/** Start a new Telegram conversation (resets the persistent conversation) */
export async function handleNewConversation(ctx: Context) {
  setCurrentTelegramConversation(null);
  await ctx.reply("Your next message starts a new chat. To go back to an old one, swipe-reply to it or use /chats.");
}

/** Handle bot commands */
export async function handleTelegramCommand(command: string, ctx: Context) {
  // Helper to extract args after the command name from the raw message text
  const rawText = ctx.message?.text ?? "";
  const cmdArgs = rawText.split(/\s+/).slice(1).join(" ").trim();

  // Delegated commands (today, weather, crypto, ...) get their prompts from the
  // shared catalog so Telegram and Discord stay in sync automatically.
  const delegated = getDelegatedPrompt(command, cmdArgs);
  if (delegated) {
    if (!delegated.ok) {
      await ctx.reply(`Usage: /${command} ${delegated.usage.replace(/^Usage:\s*/, "")}`);
      return;
    }
    await delegateToChat(ctx, delegated.prompt);
    return;
  }

  switch (command) {
    // ── Core ──────────────────────────────────────────────────────

    case "help": {
      await replyHtml(ctx, renderTelegramHelp());
      break;
    }

    case "status": {
      const allSouls = db.select().from(souls).all();
      const enabledSchedules = db.select().from(schedules).all().filter((s) => s.enabled);
      const text = [
        "<b>Chomp Status</b>",
        `Default: ${esc(channelTargetLabel("telegram"))}`,
        `Agents: ${allSouls.length}`,
        ...allSouls.map((s) => `  - ${esc(s.name)}`),
        `\nSchedules: ${enabledSchedules.length} active`,
        ...enabledSchedules.map((s) => `  - ${esc(s.naturalLanguage)}`),
      ].join("\n");
      await replyHtml(ctx, text);
      break;
    }

    // ── Agents & Sessions ─────────────────────────────────────────

    case "agents": {
      const all = db.select().from(souls).all();
      if (all.length === 0) {
        await ctx.reply("No agents configured.");
        return;
      }
      const lines = all.map((s) => {
        const desc = s.description ? esc(s.description.slice(0, 60)) + (s.description.length > 60 ? "…" : "") : "";
        return `<b>${esc(s.name)}</b>${s.isDefault ? " (default)" : ""}${desc ? `\n  ${desc}` : ""}`;
      });
      await replyHtml(ctx, `<b>Agents</b>\n\n${lines.join("\n\n")}`);
      break;
    }

    case "sessions": {
      const activeSessions = getActiveSessions();
      const { rows: recentHistory } = getSessionHistory({ limit: 5 });

      const lines: string[] = ["<b>Agent Sessions</b>\n"];

      if (activeSessions.length > 0) {
        lines.push(`Running (${activeSessions.length}):`);
        for (const s of activeSessions) {
          const runtime = Math.round((Date.now() - s.startedAt) / 1000);
          const mins = Math.floor(runtime / 60);
          const secs = runtime % 60;
          lines.push(`  ${esc(s.agentName)} — ${mins}m ${secs}s`);
          if (s.ccSessionId) {
            lines.push(`  <code>${esc(s.ccSessionId.slice(0, 8))}</code>`);
          }
          lines.push(`  /kill_${s.sessionId.slice(0, 8)}`);
        }
      } else {
        lines.push("No agents running.");
      }

      if (recentHistory.length > 0) {
        lines.push("\nRecent:");
        for (const s of recentHistory) {
          const dur = s.durationMs ? Math.round(s.durationMs / 1000) : 0;
          const mins = Math.floor(dur / 60);
          const secs = dur % 60;
          const icon = s.status === "completed" ? "+" : s.status === "failed" ? "x" : "-";
          lines.push(`  ${icon} ${esc(s.agentName)} (${s.status}) ${mins}m ${secs}s`);
          if (s.ccSessionId) {
            lines.push(`    <code>claude --resume ${esc(s.ccSessionId)}</code>`);
          }
        }
      }

      await replyHtml(ctx, lines.join("\n"));
      break;
    }

    case "kill": {
      const activeSessions2 = getActiveSessions();
      if (activeSessions2.length === 0) {
        await ctx.reply("No agents running.");
        return;
      }
      let killed = 0;
      for (const s of activeSessions2) {
        if (killSession(s.sessionId)) killed++;
      }
      await ctx.reply(`Killed ${killed} agent(s).`);
      break;
    }

    case "run": {
      if (!cmdArgs) {
        await ctx.reply("Usage: /run <agent-name>");
        return;
      }
      await delegateToChat(ctx, `Run the agent named "${cmdArgs}" now.`);
      break;
    }

    case "use": {
      if (!cmdArgs) {
        await ctx.reply("Usage: /use <agent-name>");
        return;
      }
      await delegateToChat(ctx, `Please use the "${cmdArgs}" agent to handle my next request. Confirm which agent you'll use.`);
      break;
    }

    // ── Conversation management ────────────────────────────────────

    case "resume":
    case "conversations":
      await showChatPicker(ctx);
      break;

    case "search": {
      if (!cmdArgs) {
        await ctx.reply("Usage: /search <query>");
        return;
      }
      const results = db.select().from(conversations)
        .where(like(conversations.title, `%${cmdArgs}%`))
        .orderBy(desc(conversations.updatedAt))
        .limit(10)
        .all();
      if (results.length === 0) {
        await ctx.reply(`No conversations found matching "${cmdArgs}".`);
        return;
      }
      const lines = results.map((c, i) =>
        `${i + 1}. ${esc(c.title ?? "Untitled")} — <i>${(c.updatedAt ?? "").slice(0, 10)}</i>`,
      );
      await replyHtml(ctx, `<b>Search: "${esc(cmdArgs)}"</b>\n\n${lines.join("\n")}`);
      break;
    }

    // ── Memory ─────────────────────────────────────────────────────

    case "memories": {
      const allMemories = db.select().from(memories).all();
      if (allMemories.length === 0) {
        await ctx.reply("No memories stored yet.");
        return;
      }
      const lines = allMemories.slice(0, 10).map((m) =>
        `[${esc(m.category)}] ${esc(m.content.slice(0, 80))}${m.content.length > 80 ? "…" : ""}`,
      );
      const footer = allMemories.length > 10 ? `\n\n<i>… and ${allMemories.length - 10} more</i>` : "";
      await replyHtml(ctx, `<b>Memories</b> (${allMemories.length} total)\n\n${lines.join("\n")}${footer}`);
      break;
    }

    case "remember": {
      if (!cmdArgs) {
        await ctx.reply("Usage: /remember <text>");
        return;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      db.insert(memories).values({
        id,
        content: cmdArgs,
        category: "telegram",
        source: "user",
        confidence: 100,
        createdAt: now,
        updatedAt: now,
      }).run();
      await ctx.reply(`Remembered: ${cmdArgs.slice(0, 80)}${cmdArgs.length > 80 ? "…" : ""}`);
      break;
    }

    case "recall": {
      if (!cmdArgs) {
        await ctx.reply("Usage: /recall <query>");
        return;
      }
      const query = cmdArgs.toLowerCase();
      const results = db.select().from(memories).all()
        .filter((m) => m.content.toLowerCase().includes(query) || m.category.toLowerCase().includes(query))
        .slice(0, 10);
      if (results.length === 0) {
        await ctx.reply(`No memories found matching "${cmdArgs}".`);
        return;
      }
      const lines = results.map((m) =>
        `[${esc(m.category)}] ${esc(m.content.slice(0, 100))}${m.content.length > 100 ? "…" : ""}`,
      );
      await replyHtml(ctx, `<b>Memories matching "${esc(cmdArgs)}":</b>\n\n${lines.join("\n")}`);
      break;
    }

    // ── Schedules & Rules ─────────────────────────────────────────

    case "schedules": {
      const allSchedules = db.select().from(schedules).all();
      if (allSchedules.length === 0) {
        await ctx.reply("No schedules configured.");
        return;
      }
      const lines = allSchedules.map((s) => {
        const status = s.enabled ? "+" : "-";
        const lastRun = s.lastRun ? new Date(s.lastRun).toLocaleString() : "never";
        const idPrefix = s.id.slice(0, 8);
        return `${status} ${esc(s.naturalLanguage)}\n  Cron: <code>${esc(s.cronExpression)}</code> | Last: ${lastRun}\n  /enable_${idPrefix} | /disable_${idPrefix}`;
      });
      await replyHtml(ctx, `<b>Schedules</b>\n\n${lines.join("\n\n")}`);
      break;
    }

    case "pause": {
      const active = db.select().from(schedules).all().filter((s) => s.enabled);
      for (const s of active) {
        db.update(schedules).set({ enabled: false }).where(eq(schedules.id, s.id)).run();
      }
      await ctx.reply(`Paused ${active.length} schedule(s). Use the web UI to re-enable.`);
      break;
    }

    case "mute": {
      const ms = parseDurationMs(cmdArgs);
      if (!ms) {
        await ctx.reply("Usage: /mute <duration> — e.g. /mute 1h, /mute 30m, /mute 2h30m");
        return;
      }
      const active = db.select().from(schedules).all().filter((s) => s.enabled);
      for (const s of active) {
        db.update(schedules).set({ enabled: false }).where(eq(schedules.id, s.id)).run();
      }
      const totalMins = Math.round(ms / 60000);
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      const label = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
      await ctx.reply(`Muted ${active.length} schedule(s) for ${label}. Will auto-resume.`);
      // Auto-resume after duration
      setTimeout(() => {
        for (const s of active) {
          db.update(schedules).set({ enabled: true }).where(eq(schedules.id, s.id)).run();
        }
        sendTelegramMessage(`Schedules resumed after ${label} mute (${active.length} schedule(s)).`)
          .catch(() => {});
      }, ms);
      break;
    }

    case "rules": {
      const all = db.select().from(proactiveRules).all();
      if (all.length === 0) {
        await ctx.reply("No proactive rules configured.");
        return;
      }
      const lines = all.map((r) => {
        const status = r.enabled ? "+" : "-";
        const lastRun = r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toLocaleDateString() : "never";
        return `${status} <b>${esc(r.name)}</b> (${esc(r.triggerType)}) — last: ${lastRun}`;
      });
      await replyHtml(ctx, `<b>Proactive Rules</b>\n\n${lines.join("\n")}`);
      break;
    }

    case "trigger": {
      if (!cmdArgs) {
        await ctx.reply("Usage: /trigger <rule-name>");
        return;
      }
      const query = cmdArgs.toLowerCase();
      const rule = db.select().from(proactiveRules).all().find((r) =>
        r.name.toLowerCase().includes(query),
      );
      if (!rule) {
        await ctx.reply(`No rule found matching "${cmdArgs}".`);
        return;
      }
      await ctx.reply(`Triggering rule: ${rule.name}…`);
      const result = await triggerRule(rule.id);
      if (result.ok) {
        await ctx.reply(`Rule "${rule.name}" triggered successfully.`);
      } else {
        await ctx.reply(`Rule trigger failed: ${result.error ?? "unknown error"}`);
      }
      break;
    }

    // ── Config ────────────────────────────────────────────────────

    case "settings": {
      const ghUser = db.select().from(settings).where(eq(settings.key, "github_username")).get();
      const telegramLinked = db.select().from(settings).where(eq(settings.key, "telegram_chat_id")).get();

      const enabledAgentCount = db.select().from(souls).all().length;
      const activeScheduleCount = db.select().from(schedules).all().filter((s) => s.enabled).length;
      const activeRuleCount = db.select().from(proactiveRules).all().filter((r) => r.enabled).length;

      const lines = [
        "<b>Settings</b>",
        "",
        `GitHub: ${ghUser?.value ? `@${esc(ghUser.value)}` : "not set"}`,
        `Telegram: ${telegramLinked?.value ? "linked" : "not linked"}`,
        "",
        `Default agent: <code>${esc(channelTargetLabel("telegram"))}</code>`,
        `Agents: ${enabledAgentCount} enabled`,
        `Schedules: ${activeScheduleCount} active`,
        `Rules: ${activeRuleCount} active`,
      ];
      await replyHtml(ctx, lines.join("\n"));
      break;
    }

    case "webhooks": {
      const all = db.select().from(webhooks).all();
      if (all.length === 0) {
        await ctx.reply("No webhooks configured.");
        return;
      }
      const lines = all.map((w) => {
        const status = w.enabled ? "+" : "-";
        return `${status} <b>${esc(w.name)}</b> — ${w.receiveCount} received`;
      });
      await replyHtml(ctx, `<b>Webhooks</b>\n\n${lines.join("\n")}`);
      break;
    }
  }
}

/** Handle inline keyboard button taps — resolve pending ask_user questions or run pending actions */
export async function handleCallbackQuery(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery();
    return;
  }

  // Action buttons (from notify({ actionPrompt }))
  if (data.startsWith("action:")) {
    const id = data.slice("action:".length);
    const action = resolvePendingAction(id);
    if (!action) {
      await ctx.answerCallbackQuery({ text: "Action expired. Tap again from a fresh message." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Running…" });
    try {
      const chatCtx = createTelegramChatContext(ctx, action.conversationId);
      await handleChatMessage(action.prompt, chatCtx, undefined, { deliveryChannel: "telegram" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`Error running action: ${msg}`);
    }
    return;
  }

  // /chats picker
  if (data.startsWith("chat:")) {
    const id = data.slice("chat:".length);
    if (!db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).get()) {
      await ctx.answerCallbackQuery({ text: "That chat no longer exists." });
      return;
    }
    // Touch it, or the idle rule would start a new chat on the very next message.
    db.update(conversations).set({ updatedAt: new Date().toISOString() }).where(eq(conversations.id, id)).run();
    setCurrentTelegramConversation(id);
    await ctx.answerCallbackQuery();
    const sent = await replyHtml(ctx, `Now in ${chatLabelHtml(id)}`);
    trackSentMessage(sent.message_id, id);
    return;
  }

  // A button only answers the question it was sent with, not whichever is newest.
  const tappedMsgId = ctx.callbackQuery?.message?.message_id;
  const question = pendingQuestion;
  if (question && tappedMsgId && getConversationForTelegramMsg(tappedMsgId) === question.conversationId) {
    pendingQuestion = null;
    const answered = answerPendingQuestion(question.sessionId, data);
    if (answered) {
      await ctx.answerCallbackQuery({ text: `✓ ${data}` });
      return;
    }
  }

  // No pending question or it expired
  await ctx.answerCallbackQuery({ text: "No pending question — please type your reply." });
}

/** Handle /kill_<id> commands for killing specific sessions */
export async function handleKillCommand(ctx: Context) {
  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/kill_(\w+)/);
  if (!match) return;

  const prefix = match[1];
  const activeSessions = getActiveSessions();
  const session = activeSessions.find((s) => s.sessionId.startsWith(prefix));

  if (!session) {
    await replyHtml(ctx, `No active session matching <code>${esc(prefix)}</code>.`);
    return;
  }

  if (killSession(session.sessionId)) {
    await replyHtml(ctx, `Killed ${esc(session.agentName)} (<code>${esc(session.sessionId.slice(0, 8))}</code>).`);
  } else {
    await ctx.reply("Failed to kill session.");
  }
}

/** Handle /enable_<id> commands for enabling specific schedules */
export async function handleEnableSchedule(ctx: Context) {
  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/enable_(\w+)/);
  if (!match) return;

  const prefix = match[1];
  const all = db.select().from(schedules).all();
  const sched = all.find((s) => s.id.startsWith(prefix));

  if (!sched) {
    await replyHtml(ctx, `No schedule matching <code>${esc(prefix)}</code>.`);
    return;
  }

  db.update(schedules).set({ enabled: true }).where(eq(schedules.id, sched.id)).run();
  await ctx.reply(`Enabled: ${sched.naturalLanguage}`);
}

/** Handle /disable_<id> commands for disabling specific schedules */
export async function handleDisableSchedule(ctx: Context) {
  const text = ctx.message?.text ?? "";
  const match = text.match(/^\/disable_(\w+)/);
  if (!match) return;

  const prefix = match[1];
  const all = db.select().from(schedules).all();
  const sched = all.find((s) => s.id.startsWith(prefix));

  if (!sched) {
    await replyHtml(ctx, `No schedule matching <code>${esc(prefix)}</code>.`);
    return;
  }

  db.update(schedules).set({ enabled: false }).where(eq(schedules.id, sched.id)).run();
  await ctx.reply(`Disabled: ${sched.naturalLanguage}`);
}
