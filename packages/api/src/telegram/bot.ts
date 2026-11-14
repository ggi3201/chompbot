import { Bot, InlineKeyboard, InputFile } from "grammy";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { redactTokenFromErrors } from "./redact-token.js";
import { eq } from "drizzle-orm";
import { handleTelegramMessage, handleTelegramCommand, handleNewConversation, handleKillCommand, handleCallbackQuery, handleEnableSchedule, handleDisableSchedule, registerTelegramCallbacks } from "./handlers.js";
import { markdownToTelegramHtml } from "./format.js";
import { chatLabelHtml, trackSentMessage } from "./tracking.js";
import { getSecret } from "../lib/secrets.js";
import { renderCanvasForChannel } from "../lib/canvas-render.js";
import { TELEGRAM_CHATS_GUIDE } from "../channels/command-catalog.js";

let bot: Bot | null = null;
let linkedChatId: number | null = null;

export function getBot(): Bot | null {
  return bot;
}

export function getLinkedChatId(): number | null {
  if (!linkedChatId) {
    const stored = db.select().from(settings).where(eq(settings.key, "telegram_chat_id")).get();
    if (stored) linkedChatId = parseInt(stored.value, 10);
  }
  return linkedChatId;
}

export function setLinkedChatId(chatId: number) {
  linkedChatId = chatId;
  const existing = db.select().from(settings).where(eq(settings.key, "telegram_chat_id")).get();
  if (existing) {
    db.update(settings).set({ value: String(chatId) }).where(eq(settings.key, "telegram_chat_id")).run();
  } else {
    db.insert(settings).values({ key: "telegram_chat_id", value: String(chatId) }).run();
  }
}

/** Telegram's max message length in characters */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split text into chunks that fit within Telegram's character limit.
 * Splits at paragraph boundaries first, then line boundaries, to avoid
 * cutting mid-sentence.
 */
function chunkMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split(/\n\n+/)) {
    const sep = current ? "\n\n" : "";
    if ((current + sep + paragraph).length <= TELEGRAM_MAX_LENGTH) {
      current += sep + paragraph;
    } else {
      if (current) chunks.push(current);
      // Paragraph itself too long — split at line boundaries
      if (paragraph.length > TELEGRAM_MAX_LENGTH) {
        current = "";
        for (const line of paragraph.split("\n")) {
          const lineSep = current ? "\n" : "";
          if ((current + lineSep + line).length <= TELEGRAM_MAX_LENGTH) {
            current += lineSep + line;
          } else {
            if (current) chunks.push(current);
            // Single line longer than limit — hard cut
            current = line.length <= TELEGRAM_MAX_LENGTH ? line : line.slice(0, TELEGRAM_MAX_LENGTH);
          }
        }
      } else {
        current = paragraph;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/** Send a message to the linked Telegram chat. Returns the first message_id on success, null on failure. */
export async function sendTelegramMessage(
  text: string,
  opts?: { replyToMessageId?: number; replyMarkup?: InlineKeyboard; conversationId?: string },
): Promise<number | null> {
  const b = getBot();
  const chatId = getLinkedChatId();
  if (!b || !chatId) return null;

  const chunks = chunkMessage(renderCanvasForChannel(text, "telegram"));
  let firstMsgId: number | null = null;

  const replyParams = opts?.replyToMessageId
    ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true as const } }
    : {};

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Only reply-thread the first chunk; attach the keyboard to the last chunk
    const isLast = i === chunks.length - 1;
    const extra: Record<string, unknown> = firstMsgId === null ? { ...replyParams } : {};
    if (isLast && opts?.replyMarkup) extra.reply_markup = opts.replyMarkup;
    const sentOk = (msgId: number) => {
      if (firstMsgId === null) firstMsgId = msgId;
      if (opts?.conversationId) trackSentMessage(msgId, opts.conversationId);
    };
    try {
      sentOk((await b.api.sendMessage(chatId, markdownToTelegramHtml(chunk), { parse_mode: "HTML", ...extra })).message_id);
    } catch (err) {
      // Retry without formatting in case of HTML parse errors
      try {
        sentOk((await b.api.sendMessage(chatId, chunk, extra)).message_id);
      } catch {
        console.error("[telegram] Failed to send message chunk:", err);
      }
    }
  }

  return firstMsgId;
}

/** Send a pending question to the linked Telegram chat, headed with its chat, with optional inline keyboard. Returns message_id or null. */
/** Sends an Opus-in-Ogg file as a voice note. Returns whether Telegram took it. */
export async function sendTelegramVoice(oggPath: string, caption: string, conversationId: string): Promise<boolean> {
  const b = getBot();
  const chatId = getLinkedChatId();
  if (!b || !chatId) return false;
  try {
    const sent = await b.api.sendVoice(chatId, new InputFile(oggPath), { caption });
    trackSentMessage(sent.message_id, conversationId);
    return true;
  } catch (err) {
    console.error("[telegram] Failed to send voice note:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function sendTelegramQuestion(
  question: string,
  conversationId: string,
  keyboard?: InlineKeyboard,
): Promise<number | null> {
  const b = getBot();
  const chatId = getLinkedChatId();
  if (!b || !chatId) return null;

  const escaped = question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const hint = keyboard ? "Tap a button or reply with your answer." : "Reply with your answer.";
  const html = `${chatLabelHtml(conversationId)}\n\n<b>Agent needs your input:</b>\n${escaped}\n\n<i>${hint}</i>`;

  try {
    const sent = await b.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    trackSentMessage(sent.message_id, conversationId);
    return sent.message_id;
  } catch {
    try {
      const sent = await b.api.sendMessage(chatId, `Agent needs your input:\n${question}\n\nReply with your answer.`);
      trackSentMessage(sent.message_id, conversationId);
      return sent.message_id;
    } catch (err2) {
      console.error("[telegram] Failed to send question:", err2);
      return null;
    }
  }
}

/** Stop and restart the bot with a new token */
export async function restartBot(): Promise<boolean> {
  if (bot) {
    await bot.stop();
    bot = null;
  }
  startTelegramBot();
  return bot !== null;
}

export type TelegramTokenSource = "settings" | "env";

/** The bot's token: one saved in Settings (encrypted) wins over `TELEGRAM_API_KEY` in the server's .env. */
function telegramToken(): { value: string; source: TelegramTokenSource } | null {
  const saved = getSecret("TELEGRAM_API_KEY");
  if (saved) return { value: saved, source: "settings" };
  const fromEnv = process.env.TELEGRAM_API_KEY;
  return fromEnv ? { value: fromEnv, source: "env" } : null;
}

export function telegramTokenSource(): TelegramTokenSource | null {
  return telegramToken()?.source ?? null;
}

/** Start the Telegram bot if token is configured */
export function startTelegramBot() {
  const token = telegramToken()?.value;
  if (!token) {
    console.log("[telegram] No bot token configured, skipping.");
    return;
  }

  bot = new Bot(token);
  redactTokenFromErrors(bot);

  // Register MCP callbacks for routing ask_user/reply to Telegram
  registerTelegramCallbacks();

  // Guard: only the owner's chat. Without TELEGRAM_OWNER_ID nobody gets in: a bot's name is public, and it runs agents.
  bot.use(async (ctx, next) => {
    const ownerId = process.env.TELEGRAM_OWNER_ID ? parseInt(process.env.TELEGRAM_OWNER_ID, 10) : null;
    if (!ownerId || ctx.chat?.id !== ownerId) return;
    return next();
  });
  if (!process.env.TELEGRAM_OWNER_ID) console.warn("[telegram] TELEGRAM_OWNER_ID is not set, so the bot answers nobody. Set it to your numeric Telegram user ID.");

  // Command handlers
  bot.command("start", async (ctx) => {
    setLinkedChatId(ctx.chat.id);
    await ctx.reply(`Chomp linked to this chat. You'll receive notifications here.\n\n${TELEGRAM_CHATS_GUIDE}`);
  });

  // ── Core ──────────────────────────────────────────────────────
  bot.command("help", (ctx) => handleTelegramCommand("help", ctx));
  bot.command("new", (ctx) => handleNewConversation(ctx));
  bot.command("status", (ctx) => handleTelegramCommand("status", ctx));
  bot.command("resume", (ctx) => handleTelegramCommand("resume", ctx));
  bot.command("chats", (ctx) => handleTelegramCommand("conversations", ctx));
  // The "/" menu: only what you need to find your way around. /help has the rest.
  bot.api.setMyCommands([
    { command: "new", description: "Start a new chat" },
    { command: "chats", description: "See which chat you're in, or switch" },
    { command: "status", description: "Agents and schedules overview" },
    { command: "help", description: "All commands" },
  ]).catch((err) => console.error("[telegram] Failed to set command menu:", err));

  // ── Agents & Sessions ─────────────────────────────────────────
  bot.command("agents", (ctx) => handleTelegramCommand("agents", ctx));
  bot.command("sessions", (ctx) => handleTelegramCommand("sessions", ctx));
  bot.command("run", (ctx) => handleTelegramCommand("run", ctx));
  bot.command("use", (ctx) => handleTelegramCommand("use", ctx));
  bot.command("kill", (ctx) => handleTelegramCommand("kill", ctx));

  // ── Memory ────────────────────────────────────────────────────
  bot.command("memories", (ctx) => handleTelegramCommand("memories", ctx));
  bot.command("remember", (ctx) => handleTelegramCommand("remember", ctx));
  bot.command("recall", (ctx) => handleTelegramCommand("recall", ctx));

  // ── Schedules & Rules ─────────────────────────────────────────
  bot.command("schedules", (ctx) => handleTelegramCommand("schedules", ctx));
  bot.command("pause", (ctx) => handleTelegramCommand("pause", ctx));
  bot.command("mute", (ctx) => handleTelegramCommand("mute", ctx));
  bot.command("rules", (ctx) => handleTelegramCommand("rules", ctx));
  bot.command("trigger", (ctx) => handleTelegramCommand("trigger", ctx));

  // ── Conversations ─────────────────────────────────────────────
  bot.command("conversations", (ctx) => handleTelegramCommand("conversations", ctx));
  bot.command("search", (ctx) => handleTelegramCommand("search", ctx));

  // ── Calendar & Email ──────────────────────────────────────────
  bot.command("today", (ctx) => handleTelegramCommand("today", ctx));
  bot.command("tomorrow", (ctx) => handleTelegramCommand("tomorrow", ctx));
  bot.command("event", (ctx) => handleTelegramCommand("event", ctx));
  bot.command("inbox", (ctx) => handleTelegramCommand("inbox", ctx));
  bot.command("email", (ctx) => handleTelegramCommand("email", ctx));
  bot.command("draft", (ctx) => handleTelegramCommand("draft", ctx));

  // ── GitHub ────────────────────────────────────────────────────
  bot.command("issues", (ctx) => handleTelegramCommand("issues", ctx));
  bot.command("issue", (ctx) => handleTelegramCommand("issue", ctx));
  bot.command("createissue", (ctx) => handleTelegramCommand("create-issue", ctx));

  // ── Info ──────────────────────────────────────────────────────
  bot.command("weather", (ctx) => handleTelegramCommand("weather", ctx));
  bot.command("crypto", (ctx) => handleTelegramCommand("crypto", ctx));
  bot.command("stocks", (ctx) => handleTelegramCommand("stocks", ctx));
  bot.command("news", (ctx) => handleTelegramCommand("news", ctx));

  // ── Data ──────────────────────────────────────────────────────
  bot.command("recipes", (ctx) => handleTelegramCommand("recipes", ctx));
  bot.command("drive", (ctx) => handleTelegramCommand("drive", ctx));

  // ── Config ────────────────────────────────────────────────────
  bot.command("settings", (ctx) => handleTelegramCommand("settings", ctx));
  bot.command("webhooks", (ctx) => handleTelegramCommand("webhooks", ctx));

  // ── Dynamic pattern commands ───────────────────────────────────
  // /kill_<id>, /enable_<id>, /disable_<id>
  bot.hears(/^\/kill_\w+/, (ctx) => handleKillCommand(ctx));
  bot.hears(/^\/enable_\w+/, (ctx) => handleEnableSchedule(ctx));
  bot.hears(/^\/disable_\w+/, (ctx) => handleDisableSchedule(ctx));

  // Inline keyboard button taps — route to pending ask_user answer
  bot.on("callback_query:data", (ctx) => handleCallbackQuery(ctx));

  // Regular messages — route through the full chat pipeline
  bot.on("message:text", (ctx) => handleTelegramMessage(ctx));

  // Photo and document messages — also route through chat pipeline (attachment support)
  bot.on("message:photo", (ctx) => handleTelegramMessage(ctx));
  bot.on("message:document", (ctx) => handleTelegramMessage(ctx));
  bot.on("message:voice", (ctx) => handleTelegramMessage(ctx));

  // A wrong token fails here. Unhandled, that would stop the whole API, and again on every restart.
  const starting = bot;
  bot.start({
    onStart: () => console.log("[telegram] Bot started"),
  }).catch((err: unknown) => {
    console.error(`[telegram] Bot stopped: ${err instanceof Error ? err.message : String(err)}`);
    if (bot === starting) bot = null;
  });

  // Graceful shutdown
  process.once("SIGINT", () => bot?.stop());
  process.once("SIGTERM", () => bot?.stop());
}
