import { db } from "../db/index.js";
import { skills, mcpServers, settings, souls, chatMessages, agentSessions, conversations } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { registerSessionConversation } from "../mcp/server.js";
import { hasSessionReplied, hasSessionEndedOnReply, clearSessionState, getSessionReply, getSessionConversationId, type SessionReply } from "../mcp/state.js";
import { deliverFallbackReply, humanizeTurnFailure } from "../mcp/reply-delivery.js";
import { buildMemoryContext } from "../db/memories.js";
import { getUserProfileHint } from "../user-profile.js";
import { canDispatch } from "./registry.js";
import { emit } from "../events/bus.js";
import { notify } from "../notifications/router.js";
import { getResponseFormatInstruction } from "../channels/response-format.js";
import type { ChatContext, ChatOptions } from "../chat/handler.js";
import type { AgentProvider, RoutingDecision } from "@chomp/shared";
import { normalizeAccessMode } from "@chomp/shared";
import { DEFAULT_AGENT_CWD } from "./runtime/claude.js";
import { PROVIDER_AGENT_TYPES, PROVIDER_LABELS, channelTarget, resolveRun, targetFromName } from "./run-target.js";
import { activeRuntime, closeConversationRuntime, isShuttingDown, runAgentTurn, trackRunningTurn } from "./runtime/pool.js";
import { validEffort } from "./runtime/models.js";
import { getAgentContext } from "./context-injector.js";
import { conversationCwd } from "./worktree.js";

/** Build a text block listing available skills and MCP servers for agent context injection. */
function getAgentContextBlock(provider: AgentProvider): string {
  // Claude's Skill tool already lists every skill from ~/.claude/skills.
  const enabledSkills = provider === "claude"
    ? []
    : db.select().from(skills).all().filter((s) => s.enabled && s.name !== "chomp-agent");
  const enabledMcpServers = db.select().from(mcpServers).all().filter((s) => s.enabled);

  const parts: string[] = [];

  if (enabledSkills.length > 0) {
    const list = enabledSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    parts.push(`Available skills (use get_skills tool with the name to get full instructions):\n${list}`);
  }

  if (enabledMcpServers.length > 0) {
    const list = enabledMcpServers.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    parts.push(`Installed MCP plugins (directly available via MCP bridge):\n${list}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

/** The soul a run asked for, else the one marked as default, else none. */
function resolveSoul(soulId: string | undefined): typeof souls.$inferSelect | null {
  if (soulId) {
    const soul = db.select().from(souls).where(eq(souls.id, soulId)).get();
    if (soul?.content) return soul;
  }
  // Fallback to default soul (only if one is explicitly marked as default)
  const defaultSoul = db.select().from(souls).where(eq(souls.isDefault, true)).get();
  return defaultSoul?.content ? defaultSoul : null;
}

/**
 * A native session keeps the system prompt — and so the soul — it started
 * with. When the conversation now asks for another soul, forget its sessions
 * so the next turn starts fresh with the new one (and the transcript).
 */
function switchSessionSoul(conversationId: string, soulId: string) {
  if (!conversationId) return false;
  const row = db.select({ soulId: conversations.soulId }).from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!row || row.soulId === soulId) return;
  // A conversation from before souls were tracked keeps its sessions; from now on it is tracked.
  const changed = row.soulId !== null && !activeRuntime(conversationId);
  db.update(conversations)
    .set(changed ? { soulId, ccSessionId: null, codexSessionId: null } : { soulId })
    .where(eq(conversations.id, conversationId))
    .run();
  if (changed) closeConversationRuntime(conversationId);
}

export interface AgentHandoffMessage {
  role: string;
  content: string;
  agentUsed: string | null;
}

export interface AgentHandoffSession {
  agentName: string;
  agentType: string;
  model: string | null;
  status: string;
  startedAt: string;
}

function escapeHandoffText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function compactLine(value: string, max = 700): string {
  const oneLine = escapeHandoffText(value.replace(/\s+/g, " ").trim());
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

export function shouldInjectAgentHandoff(recentSessionsNewestFirst: AgentHandoffSession[], targetAgentType: string): boolean {
  return recentSessionsNewestFirst.length > 0 && recentSessionsNewestFirst[0].agentType !== targetAgentType;
}

function withoutCurrentUserMessage(messages: AgentHandoffMessage[]): AgentHandoffMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === "user") {
      next.splice(i, 1);
      break;
    }
  }
  return next;
}

export function formatAgentHandoffContext(
  messages: AgentHandoffMessage[],
  recentSessionsChronological: AgentHandoffSession[],
  targetAgentType: string,
): string {
  const transcriptMessages = withoutCurrentUserMessage(messages);
  if (transcriptMessages.length === 0 && recentSessionsChronological.length === 0) return "";

  const parts: string[] = [
    "<agent-handoff>",
    "Chomp conversation state is canonical. Native CLI sessions are per-agent scratchpads; this handoff exists because another agent handled the latest turn. Preserve continuity from Chomp instead of assuming your CLI history is complete.",
    `target_agent_type: ${targetAgentType}`,
  ];

  if (recentSessionsChronological.length > 0) {
    parts.push("Recent agent sessions:");
    for (const session of recentSessionsChronological) {
      const model = session.model ? `, model: ${session.model}` : "";
      const memory = session.agentType === targetAgentType ? "target CLI memory" : "handoff source";
      parts.push(`- ${session.agentName} (${session.agentType}${model}, status: ${session.status}, ${memory}) at ${session.startedAt}`);
    }
  }

  if (transcriptMessages.length > 0) {
    parts.push("Recent Chomp transcript:");
    for (const message of transcriptMessages) {
      const who = message.agentUsed ? `${message.role} (${message.agentUsed})` : message.role;
      parts.push(`${who}: ${compactLine(message.content)}`);
    }
  }

  parts.push("</agent-handoff>");
  return parts.join("\n");
}

function buildAgentHandoffContext(conversationId: string | undefined, targetAgentType: string, force = false): string {
  if (!conversationId) return "";

  const sessions = db
    .select({
      agentName: agentSessions.agentName,
      agentType: agentSessions.agentType,
      model: agentSessions.model,
      status: agentSessions.status,
      startedAt: agentSessions.startedAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, conversationId))
    .orderBy(desc(agentSessions.startedAt))
    .limit(4)
    .all();

  if (!force && !shouldInjectAgentHandoff(sessions, targetAgentType)) return "";

  const messages = db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      agentUsed: chatMessages.agentUsed,
    })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(12)
    .all()
    .reverse();

  return formatAgentHandoffContext(messages, sessions.reverse(), targetAgentType);
}

function withAgentHandoff(prompt: string, conversationId: string | undefined, targetAgentType: string, force = false): string {
  const handoff = buildAgentHandoffContext(conversationId, targetAgentType, force);
  return handoff ? `${handoff}\n\n${prompt}` : prompt;
}

/** Does the conversation already have a native session for this engine? A resumed
 *  session keeps the system prompt it was created with, so building one is wasted work. */
function isResuming(conversationId: string, agentType: "claude-sdk" | "codex-sdk"): boolean {
  if (!conversationId) return false;
  const row = db.select({ cc: conversations.ccSessionId, codex: conversations.codexSessionId }).from(conversations).where(eq(conversations.id, conversationId)).get();
  return !!(agentType === "claude-sdk" ? row?.cc : row?.codex);
}

/** Soul, the chomp-agent protocol, memories and context: what a fresh CLI session starts with. */
async function buildCliSystemPrompt(
  soulContent: string | undefined,
  prompt: string,
  provider: AgentProvider,
  options?: ChatOptions,
): Promise<string> {
  const parts: string[] = [];

  // Soul — agent identity layer (first so it colors everything)
  if (soulContent) parts.push(soulContent);

  const chompSkill = db.select().from(skills).all().find((s) => s.name === "chomp-agent" && s.enabled);
  if (chompSkill) parts.push(chompSkill.content);

  const memoriesText = (await buildMemoryContext({ query: prompt })).text;
  if (memoriesText) parts.push(memoriesText);

  const userProfileHint = getUserProfileHint();
  if (userProfileHint) parts.push(userProfileHint);
  if (options?.channelContext) parts.push(`Current channel context:\n${options.channelContext}`);

  const contextBlock = getAgentContextBlock(provider);
  if (contextBlock) parts.push(contextBlock);

  const ghUser = db.select().from(settings).where(eq(settings.key, "github_username")).get();
  if (ghUser?.value) {
    parts.push(`Your GitHub identity: You operate as @${ghUser.value}. Mentions of @${ghUser.value} in issues, PRs, or comments refer to you.`);
  }

  if (options?.autonomy === "autonomous") {
    parts.push("IMPORTANT: Do NOT ask the user questions. Make all decisions yourself and just do it. Share your decisions in your reply instead of asking.");
  } else if (options?.autonomy === "cautious") {
    parts.push("IMPORTANT: Ask the user before making any ambiguous choice, creative decision, or potentially destructive action. Use chomp_ask_user liberally.");
  }

  parts.push(getResponseFormatInstruction(options?.deliveryChannel));
  return parts.join("\n\n");
}

export interface DispatchResult {
  response: string;
  agentUsed: string;
  /** If true, agent already sent messages via agent_message — don't send content in done event */
  alreadySent?: boolean;
  replyMessage?: SessionReply;
  /**
   * Some CLI runners require replies to go through Chomp tools/CLI while their
   * normal stdout can still contain assistant progress/preamble text. Once a
   * Chomp reply exists, that runner text is no longer user-facing content.
   */
  suppressRunnerResponseAfterReply?: boolean;
  /** The dispatch session id; stored on the reply as its `turn_id`. */
  turnId?: string;
}

export async function dispatchToAgent(
  routing: RoutingDecision,
  ctx: ChatContext,
  options?: ChatOptions,
): Promise<DispatchResult> {
  const named = routing.agent ? targetFromName(routing.agent) : undefined;
  if (routing.agent && !named && !options?.provider) {
    throw new Error(`Agent "${routing.agent}" not found`);
  }
  const run = resolveRun(routing, options ?? {}, named ?? channelTarget(options?.deliveryChannel));
  const agentType = PROVIDER_AGENT_TYPES[run.provider];
  const soul = resolveSoul(run.soulId);
  // Replies carry the soul's name: it is who answered.
  const speaker = soul?.name ?? PROVIDER_LABELS[run.provider];

  // Guardrail: check concurrent limit and circuit breaker
  const dispatchCheck = canDispatch(speaker);
  if (!dispatchCheck.allowed) {
    throw new Error(dispatchCheck.reason!);
  }

  const prompt = routing.prompt ?? "";
  const sessionId = randomUUID();

  // Register session → conversation mapping for persisting agent replies
  if (ctx.conversationId) {
    registerSessionConversation(sessionId, ctx.conversationId);
  }

  // Notify client about which session to track for ask_user
  ctx.send({ type: "sessionId", sessionId });

  ctx.send({
    type: "routing",
    agent: speaker,
    reason: routing.reason,
  });

  emit({ type: "agent.started", sessionId, agentName: speaker, agentType, conversationId: ctx.conversationId });
  const dispatchStartTime = Date.now();

  let result: DispatchResult;
  try {
    if (options?.compact && run.provider !== "claude") throw new Error("Compact works in Claude chats only");
    switchSessionSoul(ctx.conversationId, soul?.id ?? "");
    // A fresh native session in a conversation that already has history (a
    // new soul, a fork that could not fork natively, a session the CLI lost)
    // gets the transcript; a resumed one has it already.
    const resuming = isResuming(ctx.conversationId, agentType);
    const turnPrompt = withAgentHandoff(prompt, ctx.conversationId, agentType, !resuming);
    trackRunningTurn(ctx.conversationId, {
      agent: speaker,
      options: { provider: run.provider, model: run.model, effort: run.effort, fast: options?.fast, access: options?.access, soulId: soul?.id, deliveryChannel: options?.deliveryChannel, label: options?.label, notifyWhenDone: options?.notifyWhenDone },
    });
    const response = await runAgentTurn(run.provider, {
      sessionId,
      conversationId: ctx.conversationId,
      agentName: speaker,
      prompt: options?.compact ? prompt : (await getAgentContext()) + turnPrompt,
      userPrompt: prompt,
      systemPrompt: resuming ? undefined : await buildCliSystemPrompt(soul?.content, prompt, run.provider, options),
      model: run.model,
      effort: await validEffort(run.provider, run.model, run.effort),
      fast: options?.fast,
      // Not `run.access`: a named soul replaces the channel's target, but must not escape its supervision.
      access: normalizeAccessMode(options?.access ?? channelTarget(options?.deliveryChannel).access),
      deliveryChannel: options?.deliveryChannel,
      claudeAuthMode: "subscription",
      cwd: conversationCwd(ctx.conversationId) || DEFAULT_AGENT_CWD,
      label: options?.label,
      ctx,
    });
    result = {
      response,
      agentUsed: speaker,
      // The final text is the reply; a chomp_reply only counts as "sent" when there is no final text.
      alreadySent: !response.trim() && hasSessionReplied(sessionId),
      replyMessage: getSessionReply(sessionId),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    trackRunningTurn(ctx.conversationId, null);
    emit({ type: "agent.failed", sessionId, agentName: speaker, error: errorMsg });
    // A turn can die before sending its final reply: an idle timeout, a crashed
    // runner, or the user hitting Stop to escape a spinner that was already
    // hanging without a reply. In every case the chat handler used to persist
    // the raw internal error string ("Lingering PTY terminated …") as the
    // assistant message — replacing the answer with noise.
    //
    // The decision is purely "did a reply land this turn?", NOT how the turn
    // ended. If nothing was delivered, surface one honest recovery line — this
    // covers the user killing a silent turn (their Stop was escaping the void,
    // not aborting working work, so staying quiet would just preserve it). If a
    // reply already landed, stay silent: they have content and are merely
    // interrupting. Gated to chat-bound sessions (proactive runs handle their
    // own failures); guarded by hasSessionReplied so it can never double-post.
    // A turn replaced by "send now" was stopped on purpose; the new message is the answer to it.
    // One stopped by a shutdown is resumed after the restart, so it says nothing either.
    const superseded = !!ctx.isSuperseded?.() || isShuttingDown();
    if (getSessionConversationId(sessionId)) {
      if (!hasSessionReplied(sessionId) && !superseded) {
        try {
          deliverFallbackReply(sessionId, humanizeTurnFailure(errorMsg));
        } catch (flushErr) {
          console.error("[dispatch] Failed to flush fallback reply:", flushErr);
        }
      }
      // Mark the error as already handled so the chat handler doesn't persist a
      // raw `Error: <internal>` message on top of the reply/recovery line.
      if (err instanceof Error) (err as Error & { userNotified?: boolean }).userNotified = true;
    }
    throw err;
  }

  trackRunningTurn(ctx.conversationId, null);
  emit({ type: "agent.completed", sessionId, agentName: speaker, durationMs: Date.now() - dispatchStartTime });
  clearSessionState(sessionId);
  return { ...result, turnId: sessionId };
}
