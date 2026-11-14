import type { Message, ChatInputCommandInteraction, User } from "discord.js";
import { db } from "../db/index.js";
import { schedules, souls, memories, conversations, settings, proactiveRules, webhooks, chatMessages } from "../db/schema.js";
import { eq, desc, like } from "drizzle-orm";
import { randomUUID } from "crypto";
import { handleChatMessage, type ChatContext } from "../chat/handler.js";
import { answerPendingQuestion } from "../mcp/pending-questions.js";
import { onAskUser, onReply } from "../mcp/state.js";
import { sessionConversations } from "../mcp/state.js";
import { getDiscordOwnerId, sendDiscordMessage, sendDiscordQuestion } from "./bot.js";
import { trackSentMessage, getConversationForDiscordMsg, getLastDiscordMsgForConv } from "./tracking.js";
import { DISCORD_MAX_LENGTH } from "./format.js";
import { renderCanvasForChannel } from "../lib/canvas-render.js";
import { getActiveSessions, getSessionHistory, killSession } from "../agents/registry.js";
import { triggerRule } from "../proactive/engine.js";
import { DISCORD_COMMANDS } from "./commands.js";
import { CHANNEL_COMMANDS, getDelegatedPrompt, renderDiscordHelp } from "../channels/command-catalog.js";
import { channelTargetLabel } from "../agents/run-target.js";

// ── Discord state ──────────────────────────────────────────────

/** The question an agent is waiting on, and who it asked: anyone else's message is not the answer. */
let pendingQuestion: { sessionId: string; askedUserId: string | null } | null = null;

/** The chat plain messages go to. Moves when you reply to an older chat's message, /resume or /fresh. */
let discordConversationId: string | null = null;

let callbacksRegistered = false;

/**
 * Per-run reply bookkeeping, keyed by the agent sessionId.
 *
 * Previously this state lived in module-level globals (one `activeDiscordMessage`,
 * one `liveRepliesSent`, etc.). Because the Discord channel is a single persistent
 * conversation, two messages arriving close together — or a proactive run
 * overlapping a chat turn — would clobber each other's bookkeeping: replies got
 * dropped, duplicated, or threaded onto the wrong message, and the active message
 * pointer was nulled out from under an in-flight run.
 *
 * Keying by sessionId isolates each run completely. The map is populated when a
 * run's `sessionId` event arrives (emitted by dispatchToAgent before the agent
 * produces any reply) and cleared on `done`/`error`. The globally-registered
 * onReply/onAskUser callbacks look up the originating run here.
 */
interface DiscordRunState {
  message: Message;
  conversationId: string;
  /** Buffer for streamed chunks (direct, non-delegated responses). */
  fullResponse: string;
  /** Live chomp_reply messages sent during this run. */
  collectedReplies: string[];
  liveRepliesSent: boolean;
  liveReplyFailed: boolean;
  liveReplyChain: Promise<void>;
}

const discordRuns = new Map<string, DiscordRunState>();

function createDiscordRunState(message: Message, conversationId: string): DiscordRunState {
  return {
    message,
    conversationId,
    fullResponse: "",
    collectedReplies: [],
    liveRepliesSent: false,
    liveReplyFailed: false,
    liveReplyChain: Promise.resolve(),
  };
}

// ── Conversation management ─────────────────────────────────────

/** A plain message after this long starts a new chat: a one-word "Test" must not get answered from a months-old thread. */
const DISCORD_CHAT_IDLE_MS = 6 * 60 * 60 * 1000;

function currentDiscordConversationId(): string | null {
  discordConversationId ??= db.select().from(settings).where(eq(settings.key, "discord_conversation_id")).get()?.value || null;
  return discordConversationId;
}

function setCurrentDiscordConversation(id: string | null): void {
  discordConversationId = id;
  upsertSetting("discord_conversation_id", id ?? "");
}

function getOrCreateDiscordConversation(): string {
  const current = currentDiscordConversationId();
  const existing = current ? db.select().from(conversations).where(eq(conversations.id, current)).get() : undefined;
  if (existing && Date.now() - Date.parse(existing.updatedAt) < DISCORD_CHAT_IDLE_MS) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(conversations).values({ id, title: "Discord", createdAt: now, updatedAt: now }).run();
  setCurrentDiscordConversation(id);
  return id;
}

/** Reset the Discord conversation (for !chomp new) */
export function resetDiscordConversation(): void {
  setCurrentDiscordConversation(null);
}

/**
 * The writer's name when it isn't the bot's owner: the channel is shared with
 * family. `discord_user_names` maps Discord user ids to real names, because a
 * Discord display name can be anything. Undefined means the owner wrote it.
 */
function authorName(user: User): string | undefined {
  const ownerId = getDiscordOwnerId();
  if (!ownerId || user.id === ownerId) return undefined;
  const names = JSON.parse(db.select().from(settings).where(eq(settings.key, "discord_user_names")).get()?.value ?? "{}") as Record<string, string>;
  return names[user.id] ?? user.displayName;
}

/** Who a question in a run answers to. A notification button's message is the bot's own, so that run belongs to the owner. */
function askedUserId(message: Message): string | null {
  return message.author.bot ? getDiscordOwnerId() : message.author.id;
}

// ── MCP callbacks for Discord ──────────────────────────────────

/** Returns true if the given sessionId originated from the Discord conversation */
function isDiscordSession(sessionId: string): boolean {
  const convId = sessionConversations.get(sessionId);
  // No conversation mapping → may be a background/scheduled task — don't claim it
  if (!convId) return false;
  return convId === currentDiscordConversationId();
}

export function registerDiscordCallbacks() {
  // The bot starts again on every login retry; a second registration would post every reply twice.
  if (callbacksRegistered) return;
  callbacksRegistered = true;

  onAskUser((sessionId, question) => {
    const run = discordRuns.get(sessionId);
    if (!run && !isDiscordSession(sessionId)) return;
    // shortcut: a question from a slash command has no run, so only the owner can answer it, even if someone else ran the command; give slash commands a run if that comes up.
    pendingQuestion = { sessionId, askedUserId: run ? askedUserId(run.message) : getDiscordOwnerId() };

    if (run) {
      run.message.reply(`**Agent needs your input:**\n${question}\n\n*Reply with your answer.*`)
        .catch((err) => console.error("[discord] Failed to send question:", err));
    } else {
      sendDiscordQuestion(question)
        .catch((err) => console.error("[discord] Failed to send proactive question:", err));
    }
  });

  onReply((sessionId, reply) => {
    const run = discordRuns.get(sessionId);

    if (run) {
      run.liveRepliesSent = true;
      run.collectedReplies.push(reply.content);
      const { message, conversationId } = run;
      run.liveReplyChain = run.liveReplyChain.then(async () => {
        const parts = splitMessage(renderCanvasForChannel(reply.content, "discord"));
        for (let i = 0; i < parts.length; i++) {
          const sent = await message.reply(parts[i]);
          if (i === 0 && conversationId) {
            trackSentMessage(sent.id, conversationId);
          }
        }
      }).catch((err) => {
        run.liveReplyFailed = true;
        console.error("[discord] Failed to send live reply:", err);
      });
      return;
    }

    // No active run for this session — background/proactive Discord session.
    // Forward as a notification threaded under the conversation's last message.
    const convId = sessionConversations.get(sessionId);
    if (isDiscordSession(sessionId) && convId) {
      const replyTo = getLastDiscordMsgForConv(convId);
      sendDiscordMessage(reply.content, replyTo ? { replyToMessageId: replyTo } : undefined)
        .then((msgId) => {
          if (msgId) trackSentMessage(msgId, convId);
        })
        .catch((err) => console.error("[discord] Failed to forward reply:", err));
    }
  });
}

// ── Chat context adapter ────────────────────────────────────────

function createDiscordChatContext(message: Message, overrideConversationId?: string): ChatContext {
  const conversationId = overrideConversationId ?? getOrCreateDiscordConversation();
  // The chat you last talked in is the one your next plain message continues.
  if (conversationId !== discordConversationId) setCurrentDiscordConversation(conversationId);
  const runState = createDiscordRunState(message, conversationId);
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
          runState.fullResponse += d.content as string;
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
          } else if ((d.content as string) || runState.fullResponse) {
            content = (d.content as string) || runState.fullResponse;
          } else if (!runState.liveRepliesSent) {
            const msgId = d.messageId as string | undefined;
            const dbMsg = msgId ? db.select().from(chatMessages).where(eq(chatMessages.id, msgId)).get() : null;
            content = dbMsg?.content ?? "";
          } else {
            content = "";
          }
          if (content) {
            const parts = splitMessage(renderCanvasForChannel(content, "discord"));
            parts.reduce<Promise<void>>(
              (chain, part, idx) => chain.then(() =>
                message.reply(part).then((sent) => {
                  if (idx === 0) {
                    trackSentMessage(sent.id, conversationId);
                  }
                }),
              ),
              Promise.resolve(),
            ).catch((err) => console.error("[discord] Failed to send done:", err));
          }
          if (sessionId) discordRuns.delete(sessionId);
          break;
        }

        case "question": {
          pendingQuestion = { sessionId: d.sessionId as string, askedUserId: askedUserId(message) };
          const q = String(d.question);
          message.reply(`**Agent needs your input:**\n${q}\n\n*Reply with your answer.*`)
            .catch((err: unknown) => console.error("[discord] Failed to send question:", err));
          break;
        }

        case "error":
          message.reply(`Error: ${d.error}`)
            .catch((err) => console.error("[discord] Failed to send error:", err));
          if (sessionId) discordRuns.delete(sessionId);
          break;

        case "status":
          if (d.status === "triaging" || d.status === "routing") {
            if ("sendTyping" in message.channel) {
              message.channel.sendTyping().catch(() => {}); // Best-effort
            }
          }
          break;

        case "sessionId":
          sessionId = d.sessionId as string;
          discordRuns.set(sessionId, runState);
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

// ── Message splitting ────────────────────────────────────────────

function splitMessage(text: string, maxLen = DISCORD_MAX_LENGTH): string[] {
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
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return parts;
}

/** Discord rejects a reply over its limit, so long output continues as follow-ups. */
async function replyInParts(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  const [first, ...rest] = splitMessage(text);
  await interaction.reply(first);
  for (const part of rest) await interaction.followUp(part);
}

// ── Public handlers ─────────────────────────────────────────────

// ── Slash command helpers ─────────────────────────────────────────

function parseDurationMs(s: string): number | null {
  const h = parseInt(s.match(/(\d+)h/)?.[1] ?? "0", 10);
  const m = parseInt(s.match(/(\d+)m/)?.[1] ?? "0", 10);
  const totalMs = (h * 60 + m) * 60 * 1000;
  return totalMs > 0 ? totalMs : null;
}

function upsertSetting(key: string, value: string): void {
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value }).run();
  }
}

/** Route a prompt through the chat pipeline as a slash-command interaction */
async function delegateSlashCommand(interaction: ChatInputCommandInteraction, prompt: string): Promise<void> {
  await interaction.deferReply();

  const conversationId = getOrCreateDiscordConversation();
  let result = "";

  const chatCtx: ChatContext = {
    conversationId,
    send: (data: object) => {
      const d = data as Record<string, unknown>;
      const type = d.type as string;

      if (type === "chunk") {
        result += d.content as string;
      } else if (type === "done") {
        const content = (d.content as string) || result;
        if (content) {
          const parts = splitMessage(renderCanvasForChannel(content, "discord"));
          // Edit the deferred reply with the first chunk, follow up with the rest
          interaction.editReply(parts[0])
            .then((sent) => { if ("id" in sent) trackSentMessage(sent.id, conversationId); })
            .then(async () => {
              for (const part of parts.slice(1)) await interaction.followUp(part);
            })
            .catch((err) => console.error("[discord] Failed to edit reply:", err));
        } else {
          interaction.editReply("Done (no output).").catch(() => {});
        }
        result = "";
      } else if (type === "error") {
        interaction.editReply(`Error: ${d.error}`).catch(() => {});
      } else if (type === "routing") {
        // Routing info logged server-side only — no need to message the user
      }
    },
  };

  try {
    await handleChatMessage(prompt, chatCtx, undefined, { deliveryChannel: "discord", author: authorName(interaction.user) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`Error: ${msg}`).catch(() => {});
  }
}

// ── Slash command handler ────────────────────────────────────────

/** Handle a Discord slash command interaction */
export async function handleDiscordCommand(interaction: ChatInputCommandInteraction, handler: string): Promise<void> {
  const getArg = (name: string) => interaction.options.getString(name) ?? "";

  // Delegated commands route through the shared catalog so Discord and Telegram
  // can't drift out of sync. The first option (if any) carries free-form args.
  const delegatedSpec = CHANNEL_COMMANDS.find((c) => c.handler === handler);
  const delegatedArgs = delegatedSpec?.discord?.option ? getArg(delegatedSpec.discord.option.name) : "";
  const delegated = getDelegatedPrompt(handler, delegatedArgs);
  if (delegated) {
    if (!delegated.ok) {
      await interaction.reply(delegated.usage);
      return;
    }
    await delegateSlashCommand(interaction, delegated.prompt);
    return;
  }

  switch (handler) {
    // ── Core ──────────────────────────────────────────────────────

    case "help": {
      await replyInParts(interaction, renderDiscordHelp());
      break;
    }

    case "status": {
      const allSouls = db.select().from(souls).all();
      const enabledSchedules = db.select().from(schedules).all().filter((s) => s.enabled);
      const lines = [
        "**Chomp Status**",
        `Default: ${channelTargetLabel("discord")}`,
        `Agents: ${allSouls.length}`,
        ...allSouls.map((s) => `  - ${s.name}`),
        `\nSchedules: ${enabledSchedules.length} active`,
        ...enabledSchedules.map((s) => `  - ${s.naturalLanguage}`),
      ];
      await replyInParts(interaction, lines.join("\n"));
      break;
    }

    case "fresh": {
      resetDiscordConversation();
      await interaction.reply("Started a new conversation. Previous history is still accessible in the web UI.");
      break;
    }

    // ── Agents & Sessions ─────────────────────────────────────────

    case "agents": {
      const all = db.select().from(souls).all();
      if (all.length === 0) {
        await interaction.reply("No agents configured.");
        return;
      }
      const lines = all.map((s) => {
        const desc = s.description ? s.description.slice(0, 60) + (s.description.length > 60 ? "…" : "") : "";
        return `**${s.name}**${s.isDefault ? " (default)" : ""}${desc ? `\n  ${desc}` : ""}`;
      });
      await replyInParts(interaction, `**Agents**\n\n${lines.join("\n\n")}`);
      break;
    }

    case "sessions": {
      const activeSessions = getActiveSessions();
      const { rows: recentHistory } = getSessionHistory({ limit: 5 });

      const lines: string[] = ["**Agent Sessions**\n"];

      if (activeSessions.length > 0) {
        lines.push(`Running (${activeSessions.length}):`);
        for (const s of activeSessions) {
          const runtime = Math.round((Date.now() - s.startedAt) / 1000);
          const mins = Math.floor(runtime / 60);
          const secs = runtime % 60;
          lines.push(`  ${s.agentName} — ${mins}m ${secs}s`);
          if (s.ccSessionId) lines.push(`  \`${s.ccSessionId.slice(0, 8)}\``);
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
          lines.push(`  ${icon} ${s.agentName} (${s.status}) ${mins}m ${secs}s`);
        }
      }

      await replyInParts(interaction, lines.join("\n"));
      break;
    }

    case "kill": {
      const activeSessions2 = getActiveSessions();
      if (activeSessions2.length === 0) {
        await interaction.reply("No agents running.");
        return;
      }
      let killed = 0;
      for (const s of activeSessions2) {
        if (killSession(s.sessionId)) killed++;
      }
      await interaction.reply(`Killed ${killed} agent(s).`);
      break;
    }

    case "run": {
      const name = getArg("name");
      await delegateSlashCommand(interaction, `Run the agent named "${name}" now.`);
      break;
    }

    case "use": {
      const agent = getArg("agent");
      await delegateSlashCommand(interaction, `Please use the "${agent}" agent to handle my next request. Confirm which agent you'll use.`);
      break;
    }

    // ── Conversation management ────────────────────────────────────

    case "resume": {
      const all = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(20).all();
      const current = currentDiscordConversationId();
      const previous = all.find((c) => c.id !== current);
      if (!previous) {
        await interaction.reply("No previous conversation to resume.");
        return;
      }
      // Touch it, or the idle rule would start a new chat on the very next message.
      db.update(conversations).set({ updatedAt: new Date().toISOString() }).where(eq(conversations.id, previous.id)).run();
      setCurrentDiscordConversation(previous.id);
      await interaction.reply(`Resumed conversation: **${previous.title ?? "Untitled"}**`);
      break;
    }

    case "conversations": {
      const recent = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(10).all();
      if (recent.length === 0) {
        await interaction.reply("No conversations yet.");
        return;
      }
      const current = currentDiscordConversationId();
      const lines = recent.map((c, i) => {
        const active = c.id === current ? " (active)" : "";
        return `${i + 1}. ${c.title ?? "Untitled"}${active} — *${(c.updatedAt ?? "").slice(0, 10)}*`;
      });
      await interaction.reply(`**Recent Conversations**\n\n${lines.join("\n")}`);
      break;
    }

    case "search": {
      const query = getArg("query");
      const results = db.select().from(conversations)
        .where(like(conversations.title, `%${query}%`))
        .orderBy(desc(conversations.updatedAt))
        .limit(10)
        .all();
      if (results.length === 0) {
        await interaction.reply(`No conversations found matching "${query}".`);
        return;
      }
      const lines = results.map((c, i) =>
        `${i + 1}. ${c.title ?? "Untitled"} — *${(c.updatedAt ?? "").slice(0, 10)}*`,
      );
      await interaction.reply(`**Search: "${query}"**\n\n${lines.join("\n")}`);
      break;
    }

    // ── Memory ─────────────────────────────────────────────────────

    case "memories": {
      const allMemories = db.select().from(memories).all();
      if (allMemories.length === 0) {
        await interaction.reply("No memories stored yet.");
        return;
      }
      const lines = allMemories.slice(0, 10).map((m) =>
        `[${m.category}] ${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}`,
      );
      const footer = allMemories.length > 10 ? `\n\n*… and ${allMemories.length - 10} more*` : "";
      await interaction.reply(`**Memories** (${allMemories.length} total)\n\n${lines.join("\n")}${footer}`);
      break;
    }

    case "remember": {
      const text = getArg("text");
      const id = randomUUID();
      const now = new Date().toISOString();
      db.insert(memories).values({
        id,
        content: text,
        category: "discord",
        source: "user",
        confidence: 100,
        createdAt: now,
        updatedAt: now,
      }).run();
      await interaction.reply(`Remembered: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
      break;
    }

    case "recall": {
      const query = getArg("query").toLowerCase();
      const results = db.select().from(memories).all()
        .filter((m) => m.content.toLowerCase().includes(query) || m.category.toLowerCase().includes(query))
        .slice(0, 10);
      if (results.length === 0) {
        await interaction.reply(`No memories found matching "${getArg("query")}".`);
        return;
      }
      const lines = results.map((m) =>
        `[${m.category}] ${m.content.slice(0, 100)}${m.content.length > 100 ? "…" : ""}`,
      );
      await interaction.reply(`**Memories matching "${getArg("query")}":**\n\n${lines.join("\n")}`);
      break;
    }

    // ── Schedules & Rules ─────────────────────────────────────────

    case "schedules": {
      const allSchedules = db.select().from(schedules).all();
      if (allSchedules.length === 0) {
        await interaction.reply("No schedules configured.");
        return;
      }
      const lines = allSchedules.map((s) => {
        const status = s.enabled ? "+" : "-";
        const lastRun = s.lastRun ? new Date(s.lastRun).toLocaleString() : "never";
        return `${status} ${s.naturalLanguage}\n  Cron: \`${s.cronExpression}\` | Last: ${lastRun}`;
      });
      await replyInParts(interaction, `**Schedules**\n\n${lines.join("\n\n")}`);
      break;
    }

    case "pause": {
      const active = db.select().from(schedules).all().filter((s) => s.enabled);
      for (const s of active) {
        db.update(schedules).set({ enabled: false }).where(eq(schedules.id, s.id)).run();
      }
      await interaction.reply(`Paused ${active.length} schedule(s). Use the web UI to re-enable.`);
      break;
    }

    case "mute": {
      const ms = parseDurationMs(getArg("duration"));
      if (!ms) {
        await interaction.reply("Invalid duration — use e.g. `1h`, `30m`, `2h30m`.");
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
      await interaction.reply(`Muted ${active.length} schedule(s) for ${label}. Will auto-resume.`);
      setTimeout(() => {
        for (const s of active) {
          db.update(schedules).set({ enabled: true }).where(eq(schedules.id, s.id)).run();
        }
        sendDiscordMessage(`Schedules resumed after ${label} mute (${active.length} schedule(s)).`).catch(() => {});
      }, ms);
      break;
    }

    case "rules": {
      const all = db.select().from(proactiveRules).all();
      if (all.length === 0) {
        await interaction.reply("No proactive rules configured.");
        return;
      }
      const lines = all.map((r) => {
        const status = r.enabled ? "+" : "-";
        const lastRun = r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toLocaleDateString() : "never";
        return `${status} **${r.name}** (${r.triggerType}) — last: ${lastRun}`;
      });
      await replyInParts(interaction, `**Proactive Rules**\n\n${lines.join("\n")}`);
      break;
    }

    case "trigger": {
      const ruleName = getArg("rule");
      const query = ruleName.toLowerCase();
      const rule = db.select().from(proactiveRules).all().find((r) =>
        r.name.toLowerCase().includes(query),
      );
      if (!rule) {
        await interaction.reply(`No rule found matching "${ruleName}".`);
        return;
      }
      await interaction.deferReply();
      const result = await triggerRule(rule.id);
      if (result.ok) {
        await interaction.editReply(`Rule "${rule.name}" triggered successfully.`);
      } else {
        await interaction.editReply(`Rule trigger failed: ${result.error ?? "unknown error"}`);
      }
      break;
    }

    // ── Config ────────────────────────────────────────────────────

    case "settings": {
      const ghUser = db.select().from(settings).where(eq(settings.key, "github_username")).get();
      const discordLinked = db.select().from(settings).where(eq(settings.key, "discord_channel_id")).get();

      const enabledAgentCount = db.select().from(souls).all().length;
      const activeScheduleCount = db.select().from(schedules).all().filter((s) => s.enabled).length;
      const activeRuleCount = db.select().from(proactiveRules).all().filter((r) => r.enabled).length;

      const lines = [
        "**Settings**",
        "",
        `GitHub: ${ghUser?.value ? `@${ghUser.value}` : "not set"}`,
        `Discord: ${discordLinked?.value ? "linked" : "not linked"}`,
        "",
        `Default agent: \`${channelTargetLabel("discord")}\``,
        `Agents: ${enabledAgentCount} enabled`,
        `Schedules: ${activeScheduleCount} active`,
        `Rules: ${activeRuleCount} active`,
      ];
      await interaction.reply(lines.join("\n"));
      break;
    }

    case "webhooks": {
      const all = db.select().from(webhooks).all();
      if (all.length === 0) {
        await interaction.reply("No webhooks configured.");
        return;
      }
      const lines = all.map((w) => {
        const status = w.enabled ? "+" : "-";
        return `${status} **${w.name}** — ${w.receiveCount} received`;
      });
      await replyInParts(interaction, `**Webhooks**\n\n${lines.join("\n")}`);
      break;
    }

    default:
      await interaction.reply(`Unknown command: ${handler}`);
  }
}

// ── Attachment helpers ─────────────────────────────────────────

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".html", ".htm", ".css", ".js", ".ts", ".json", ".csv", ".xml", ".yaml", ".yml", ".toml", ".py", ".sh", ".sql", ".log", ".tsx", ".jsx", ".svelte", ".vue"]);
const MAX_TEXT_FILE_SIZE = 100_000; // 100 KB — skip huge files

/** Extract image URLs and text file content from Discord message attachments */
async function extractAttachments(message: Message): Promise<{ images: string[]; fileContext: string }> {
  const images: string[] = [];
  const fileContextParts: string[] = [];

  for (const [, attachment] of message.attachments) {
    const contentType = attachment.contentType ?? "";
    const name = attachment.name ?? "file";
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";

    if (IMAGE_TYPES.has(contentType)) {
      // Image — pass URL for vision
      images.push(attachment.url);
    } else if (TEXT_EXTENSIONS.has(ext) && (attachment.size ?? 0) <= MAX_TEXT_FILE_SIZE) {
      // Text file — download and embed as context
      try {
        const res = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const content = await res.text();
          const escaped = content.replaceAll("```", "\\`\\`\\`");
          fileContextParts.push(`📎 Attached file: **${name}** (${attachment.size} bytes)\n\`\`\`\n${escaped}\n\`\`\``);
        }
      } catch {
        fileContextParts.push(`📎 Attached file: **${name}** (failed to download)`);
      }
    } else if (TEXT_EXTENSIONS.has(ext) && (attachment.size ?? 0) > MAX_TEXT_FILE_SIZE) {
      fileContextParts.push(`📎 Attached file: **${name}** (${Math.round((attachment.size ?? 0) / 1024)} KB — too large to embed, skipped)`);
    }
  }

  return { images, fileContext: fileContextParts.join("\n\n") };
}

/** Resolve Discord <@ID> mentions to @DisplayName so agent routing works */
function resolveDiscordMentions(message: Message): string {
  let text = message.content;
  for (const [userId, user] of message.mentions.users) {
    // Try guild nickname first, fall back to global display name, then username
    const member = message.guild?.members.cache.get(userId);
    const name = member?.nickname ?? user.displayName ?? user.username;
    text = text.replace(new RegExp(`<@!?${userId}>`, "g"), `@${name}`);
  }
  return text;
}

/**
 * Run a server-provided prompt (from an actionPrompt button tap) as if the
 * user had typed it. `message` is the notification that held the button;
 * replies thread to it so the agent output stays in context.
 */
export async function handleDiscordActionPrompt(
  message: Message,
  prompt: string,
  conversationId?: string,
): Promise<void> {
  try {
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping().catch(() => {});
    }

    const chatCtx = createDiscordChatContext(message, conversationId);
    await handleChatMessage(prompt, chatCtx, undefined, { deliveryChannel: "discord" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await message.reply(`Error running action: ${msg}`);
  }
}

/** Handle a regular text message from Discord */
export async function handleDiscordMessage(message: Message) {
  const rawText = resolveDiscordMentions(message);

  // Extract attachments (images + text files)
  const { images, fileContext } = await extractAttachments(message);

  // Build the full message: text + any embedded file content
  const text = fileContext ? (rawText ? `${rawText}\n\n${fileContext}` : fileContext) : rawText;
  if (!text && images.length === 0) return;

  // A message from the person who was asked is the answer (raw text only, not file context)
  const question = pendingQuestion;
  if (question && rawText && (!question.askedUserId || question.askedUserId === message.author.id)) {
    pendingQuestion = null;
    const answered = answerPendingQuestion(question.sessionId, rawText);
    if (answered) {
      await message.reply("Answer sent to agent.");
      return;
    }
    // If the question expired, fall through to normal handling
  }

  // Detect reply to a tracked bot message → route to originating conversation
  let overrideConversationId: string | undefined;
  let replyContext = "";
  const repliedToMsgId = message.reference?.messageId;
  if (repliedToMsgId) {
    const convId = getConversationForDiscordMsg(repliedToMsgId);
    if (convId) {
      const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get();
      if (conv) overrideConversationId = convId;
    }
    // Extract the text of the message being replied to so the agent has context
    try {
      const repliedToMsg = await message.channel.messages.fetch(repliedToMsgId);
      const repliedToText = repliedToMsg?.content;
      if (repliedToText) {
        const truncated = repliedToText.length > 500 ? repliedToText.slice(0, 500) + "…" : repliedToText;
        replyContext = `[Replying to: "${truncated}"]\n\n`;
      }
    } catch {
      // Message may have been deleted or inaccessible — continue without context
    }
  }

  try {
    // Show typing indicator while processing
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping().catch(() => {});
    }

    const chatCtx = createDiscordChatContext(message, overrideConversationId);
    await handleChatMessage(replyContext + (text || ""), chatCtx, images.length > 0 ? images : undefined, { deliveryChannel: "discord", author: authorName(message.author) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await message.reply(`Error: ${msg}`);
  }
}
