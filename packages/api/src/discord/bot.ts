import { Client, GatewayIntentBits, REST, Routes, type TextChannel, type Message, type ChatInputCommandInteraction, type ActionRowBuilder, type ButtonBuilder } from "discord.js";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { handleDiscordMessage, handleDiscordCommand, handleDiscordActionPrompt, registerDiscordCallbacks } from "./handlers.js";
import { resolvePendingAction } from "../notifications/pending-actions.js";
import { chunkMessage } from "./format.js";
import { getSecret } from "../lib/secrets.js";
import { renderCanvasForChannel } from "../lib/canvas-render.js";
import { getCommandsJSON, findCommand } from "./commands.js";

let client: Client | null = null;
let linkedChannelId: string | null = null;
let ownerId: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let shutdownHandlersRegistered = false;

const DISCORD_RECONNECT_BASE_MS = 5_000;
const DISCORD_RECONNECT_MAX_MS = 5 * 60_000;

export function getClient(): Client | null {
  return client;
}

/** The Discord user who owns the bot: the person Chomp belongs to. Null until the bot is ready. */
export function getDiscordOwnerId(): string | null {
  return ownerId;
}

/**
 * Who may use the bot: its owner (the Discord account that owns the application) and the people in the
 * `discord_user_names` setting (Discord user id → name). Everyone else is ignored, wherever they write.
 */
export function isAllowedDiscordUser(userId: string): boolean {
  if (ownerId && userId === ownerId) return true;
  const names = JSON.parse(db.select().from(settings).where(eq(settings.key, "discord_user_names")).get()?.value ?? "{}") as Record<string, string>;
  return Object.hasOwn(names, userId);
}

/** The owner lookup at startup can fail on the network; try again before deciding someone is a stranger. */
async function ensureOwnerKnown(): Promise<void> {
  if (ownerId || !client?.application) return;
  const app = await client.application.fetch().catch(() => null);
  ownerId = app?.owner?.id ?? null;
}

export function getLinkedChannelId(): string | null {
  if (!linkedChannelId) {
    const stored = db.select().from(settings).where(eq(settings.key, "discord_channel_id")).get();
    if (stored) linkedChannelId = stored.value;
  }
  return linkedChannelId;
}

export function setLinkedChannelId(channelId: string) {
  linkedChannelId = channelId;
  const existing = db.select().from(settings).where(eq(settings.key, "discord_channel_id")).get();
  if (existing) {
    db.update(settings).set({ value: channelId }).where(eq(settings.key, "discord_channel_id")).run();
  } else {
    db.insert(settings).values({ key: "discord_channel_id", value: channelId }).run();
  }
}

/** Send a message to the linked Discord channel. Returns the message ID on success, null on failure. */
export async function sendDiscordMessage(
  text: string,
  opts?: { replyToMessageId?: string; components?: ActionRowBuilder<ButtonBuilder>[] },
): Promise<string | null> {
  const c = getClient();
  const channelId = getLinkedChannelId();
  if (!c || !channelId) return null;

  try {
    const channel = await c.channels.fetch(channelId) as TextChannel | null;
    if (!channel || !("send" in channel)) return null;

    const chunks = chunkMessage(renderCanvasForChannel(text, "discord"));
    let firstMsgId: string | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;
      const msgOpts: { reply?: { messageReference: string }; components?: ActionRowBuilder<ButtonBuilder>[] } = {};
      if (firstMsgId === null && opts?.replyToMessageId) {
        msgOpts.reply = { messageReference: opts.replyToMessageId };
      }
      if (isLast && opts?.components?.length) {
        msgOpts.components = opts.components;
      }

      try {
        const sent = await channel.send({ content: chunk, ...msgOpts });
        if (firstMsgId === null) firstMsgId = sent.id;
      } catch {
        // Retry without reply reference if it fails (e.g. original message deleted)
        try {
          const sent = await channel.send({
            content: chunk,
            ...(isLast && opts?.components?.length ? { components: opts.components } : {}),
          });
          if (firstMsgId === null) firstMsgId = sent.id;
        } catch (err) {
          console.error("[discord] Failed to send message chunk:", err);
        }
      }
    }

    return firstMsgId;
  } catch (err) {
    console.error("[discord] Failed to send message:", err);
    return null;
  }
}

/** Send a pending question to the linked Discord channel. Returns message ID or null. */
export async function sendDiscordQuestion(
  question: string,
  opts?: { replyToMessageId?: string },
): Promise<string | null> {
  const text = `**Agent needs your input:**\n${question}\n\n*Reply with your answer.*`;
  return sendDiscordMessage(text, opts);
}

/** Stop and restart the bot with a new token */
export async function restartBot(): Promise<boolean> {
  clearReconnectTimer();
  if (client) {
    await client.destroy();
    client = null;
  }
  return startDiscordBot();
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(
    DISCORD_RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    DISCORD_RECONNECT_MAX_MS,
  );
  reconnectAttempt += 1;

  console.log(`[discord] Retrying login in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startDiscordBot();
  }, delay);
}

function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const shutdown = () => {
    clearReconnectTimer();
    client?.destroy();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/** Start the Discord bot if token is configured. Returns true if started. */
export function startDiscordBot(): boolean {
  const token = getSecret("DISCORD_BOT_TOKEN");
  if (!token) {
    console.log("[discord] No bot token configured, skipping.");
    return false;
  }

  clearReconnectTimer();
  registerShutdownHandlers();

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // discord.js routes a rejected async listener here. With no listener, Node
  // treats it as uncaught and the failed Discord reply takes down all of Chomp.
  client.on("error", (err) => console.error("[discord] Client error:", err));

  // Register MCP callbacks for routing ask_user/reply to Discord
  registerDiscordCallbacks();

  client.once("ready", async (c) => {
    reconnectAttempt = 0;
    console.log(`[discord] Bot started as ${c.user.tag}`);

    // shortcut: a bot owned by a Discord team gets the team's id here, so everyone counts as "not the owner"; read Team.ownerId if the bot ever moves to a team.
    const app = await c.application.fetch().catch((err) => {
      console.error("[discord] Failed to look up the bot owner:", err);
      return null;
    });
    ownerId = app?.owner?.id ?? null;

    // Auto-link to the configured channel ID if set in settings
    const configuredChannel = getSecret("DISCORD_NOTIFICATION_CHANNEL_ID")
      ?? db.select().from(settings).where(eq(settings.key, "discord_notification_channel_id")).get()?.value;
    if (configuredChannel && !linkedChannelId) {
      setLinkedChannelId(configuredChannel);
      console.log(`[discord] Auto-linked to channel ${configuredChannel}`);
    }

    // Register slash commands with Discord API
    try {
      const rest = new REST({ version: "10" }).setToken(token);
      const commands = getCommandsJSON();
      await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
      console.log(`[discord] Registered ${commands.length} slash commands`);
    } catch (err) {
      console.error("[discord] Failed to register slash commands:", err);
    }
  });

  // Handle slash command and button interactions
  client.on("interactionCreate", async (interaction) => {
    await ensureOwnerKnown();
    if (!isAllowedDiscordUser(interaction.user.id)) {
      if (interaction.isRepliable()) await interaction.reply({ content: "Only the people this Chomp belongs to can use it.", ephemeral: true });
      return;
    }
    // Channel gating — only respond in the linked channel
    const linked = getLinkedChannelId();
    if (linked && interaction.channelId !== linked) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "Chomp isn't linked to this channel. Use `!chomp link` first.", ephemeral: true });
      }
      return;
    }

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith("action:")) return;
      const id = interaction.customId.slice("action:".length);
      const action = resolvePendingAction(id);
      if (!action) {
        await interaction.reply({ content: "Action expired. Trigger it again from a fresh message.", ephemeral: true });
        return;
      }
      // Ack fast (Discord's 3s window), then dispatch. The response arrives as
      // replies to the original notification message.
      await interaction.reply({ content: `Running: ${action.prompt.slice(0, 80)}`, ephemeral: true });
      const notificationMsg = interaction.message;
      handleDiscordActionPrompt(notificationMsg as Message, action.prompt, action.conversationId)
        .catch((err) => console.error("[discord] Action prompt failed:", err));
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const def = findCommand(interaction.commandName);
    if (!def) {
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
      return;
    }

    await handleDiscordCommand(interaction as ChatInputCommandInteraction, def.handler);
  });

  // Handle incoming messages
  client.on("messageCreate", async (message: Message) => {
    // Ignore messages from bots (including self)
    if (message.author.bot) return;
    // Strangers are ignored before anything else, including !chomp link.
    await ensureOwnerKnown();
    if (!isAllowedDiscordUser(message.author.id)) return;

    // Only respond in the linked channel (if one is set)
    const linked = getLinkedChannelId();
    if (linked && message.channelId !== linked) return;

    // Handle !link command to link this channel
    if (message.content === "!chomp link") {
      setLinkedChannelId(message.channelId);
      await message.reply("Chomp linked to this channel. You'll receive notifications and can chat here.");
      return;
    }

    // Handle !new command to start a fresh conversation
    if (message.content === "!chomp new") {
      const { resetDiscordConversation } = await import("./handlers.js");
      resetDiscordConversation();
      await message.reply("Started a new conversation. Previous history is still accessible in the web UI.");
      return;
    }

    // Route through the chat pipeline
    await handleDiscordMessage(message);
  });

  client.login(token).catch((err) => {
    console.error("[discord] Failed to login:", err);
    client = null;
    scheduleReconnect();
  });

  return true;
}
