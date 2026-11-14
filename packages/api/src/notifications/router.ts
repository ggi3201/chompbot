import { InlineKeyboard } from "grammy";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { sendTelegramMessage, getLinkedChatId } from "../telegram/bot.js";
import { getLastTelegramMsgForConv } from "../telegram/tracking.js";
import { sendDiscordMessage, getLinkedChannelId } from "../discord/bot.js";
import { trackSentMessage as trackDiscordMessage, getLastDiscordMsgForConv } from "../discord/tracking.js";
import { createPendingAction } from "./pending-actions.js";
import { sendToWeb } from "./web-connections.js";

export type NotificationType = "schedule-result" | "ask-user" | "agent-complete" | "system";

export type NotificationChannel = "telegram" | "discord";

interface NotificationOptions {
  type: NotificationType;
  title: string;
  body: string;
  /**
   * If true, send to ALL available channels instead of stopping at the first.
   * Use for proactive/scheduled messages that should reach the user everywhere.
   */
  broadcast?: boolean;
  /** Conversation ID for Telegram threading — tracks sent message for reply routing */
  conversationId?: string;
  /**
   * Restrict delivery to specific channels.
   * If omitted, all available channels are used (legacy behavior).
   */
  channels?: NotificationChannel[];
  /**
   * Prompt text the user can trigger from the notification. On Telegram and
   * Discord, a button is attached; tapping it dispatches the prompt through
   * the chat pipeline immediately.
   */
  actionPrompt?: string;
  /** Button label shown on Telegram/Discord when actionPrompt is set. Defaults to "▶️ Run". */
  actionLabel?: string;
}

/**
 * Route a notification to the best available channel.
 * Priority: Telegram (if linked) → Discord (if linked) → logged only
 * Use broadcast:true to send to all channels simultaneously.
 *
 * Never pushed to the web chat: the web has no place to keep a notification,
 * so it showed up as a bubble in whatever chat was open and vanished on refresh.
 * Proactive and scheduled results already live in their own conversation.
 */
export async function notify(opts: NotificationOptions): Promise<"telegram" | "discord" | "none"> {
  const { title, body, broadcast = false, channels, actionPrompt } = opts;
  const actionLabel = opts.actionLabel ?? "▶️ Run";

  // One pending-action id shared across Telegram + Discord so tapping in either
  // consumes the same action. Created lazily on first use.
  let actionId: string | undefined;
  const getActionId = (): string | undefined => {
    if (!actionPrompt) return undefined;
    if (!actionId) actionId = createPendingAction(actionPrompt, opts.conversationId);
    return actionId;
  };

  const telegramKeyboard = (): InlineKeyboard | undefined => {
    const id = getActionId();
    return id ? new InlineKeyboard().text(actionLabel, `action:${id}`) : undefined;
  };

  const discordComponents = (): ActionRowBuilder<ButtonBuilder>[] | undefined => {
    const id = getActionId();
    if (!id) return undefined;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`action:${id}`)
        .setLabel(actionLabel.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
    return [row];
  };

  // Helper: check if a channel is allowed by the channels filter
  const allowed = (ch: NotificationChannel) => !channels || channels.includes(ch);

  if (broadcast || channels) {
    // Send to selected channels (or all if no filter).
    let telegramSent = false;
    if (allowed("telegram") && getLinkedChatId()) {
      const text = `*${title}*\n${body}`;
      const replyTo = opts.conversationId ? getLastTelegramMsgForConv(opts.conversationId) : undefined;
      const keyboard = telegramKeyboard();
      const msgId = await sendTelegramMessage(text, {
        conversationId: opts.conversationId,
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(keyboard ? { replyMarkup: keyboard } : {}),
      });
      telegramSent = msgId !== null;
    }
    let discordSent = false;
    if (allowed("discord") && getLinkedChannelId()) {
      const text = `**${title}**\n${body}`;
      const replyTo = opts.conversationId ? getLastDiscordMsgForConv(opts.conversationId) : undefined;
      const components = discordComponents();
      const msgId = await sendDiscordMessage(text, {
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(components ? { components } : {}),
      });
      discordSent = msgId !== null;
      if (msgId && opts.conversationId) trackDiscordMessage(msgId, opts.conversationId);
    }
    if (telegramSent || discordSent) return telegramSent ? "telegram" : "discord";
    console.log(`[notify] No channel available for: ${title}`);
    return "none";
  }

  // Try Telegram
  if (getLinkedChatId()) {
    const text = `*${title}*\n${body}`;
    const replyTo = opts.conversationId ? getLastTelegramMsgForConv(opts.conversationId) : undefined;
    const keyboard = telegramKeyboard();
    const msgId = await sendTelegramMessage(text, {
      conversationId: opts.conversationId,
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
      ...(keyboard ? { replyMarkup: keyboard } : {}),
    });
    if (msgId) return "telegram";
  }

  // Try Discord
  if (getLinkedChannelId()) {
    const text = `**${title}**\n${body}`;
    const replyTo = opts.conversationId ? getLastDiscordMsgForConv(opts.conversationId) : undefined;
    const components = discordComponents();
    const msgId = await sendDiscordMessage(text, {
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
      ...(components ? { components } : {}),
    });
    if (msgId) {
      if (opts.conversationId) trackDiscordMessage(msgId, opts.conversationId);
      return "discord";
    }
  }

  console.log(`[notify] No channel available for: ${title}`);
  return "none";
}

/**
 * Route an ask_user question with Telegram fallback.
 * If the user doesn't answer on web within `fallbackDelayMs`, forward to Telegram.
 */
export async function notifyAskUser(
  question: string,
  sessionId: string,
  fallbackDelayMs = 30_000,
): Promise<void> {
  // First try web
  const sentToWeb = sendToWeb({ type: "question", question, sessionId });

  if (!sentToWeb && getLinkedChatId()) {
    // No web connection — send to Telegram immediately
    await sendTelegramMessage(`*Agent needs your input:*\n${question}\n\n_Reply here or in the web UI._`);
    return;
  }

  if (sentToWeb && getLinkedChatId()) {
    // Web is connected, but set up Telegram fallback
    setTimeout(async () => {
      // Check if question is still pending (the pending-questions module handles this)
      await sendTelegramMessage(`*Reminder — agent is waiting:*\n${question}\n\n_Answer in the web UI._`);
    }, fallbackDelayMs);
  }
}
