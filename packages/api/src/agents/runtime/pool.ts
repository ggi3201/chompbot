import { eq } from "drizzle-orm";
import type { AgentProvider, ApprovalDecision, ContextUsage } from "@chomp/shared";
import type { ApprovalOutcome, ApprovalQuestion } from "./approval.js";
import { db } from "../../db/index.js";
import { conversations } from "../../db/schema.js";
import { registerSessionConversation } from "../../mcp/state.js";
import { ClaudeRuntime, forgetClaudeSession } from "./claude.js";
import { CodexRuntime } from "./codex.js";
import { readContextUsage } from "./context.js";
import type { AgentRuntime, TurnRequest } from "./types.js";

type PooledRuntime = AgentRuntime & { readonly failed: Error | null };

/** Idle sessions hold a CLI process and its memory; a cold start costs a few seconds. */
const IDLE_CLOSE_MS = 30 * 60 * 1000;

const runtimes = new Map<string, PooledRuntime>();

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [conversationId, runtime] of runtimes) {
    if (!runtime.busy && !runtime.hasLiveAgents && now - runtime.lastUsedAt > IDLE_CLOSE_MS) closeConversationRuntime(conversationId);
  }
}, 60_000);
sweep.unref();

export function closeConversationRuntime(conversationId: string) {
  const runtime = runtimes.get(conversationId);
  if (!runtime) return;
  runtimes.delete(conversationId);
  runtime.close();
}

function startRuntime(provider: AgentProvider, request: TurnRequest): PooledRuntime {
  if (provider !== "claude") return CodexRuntime.start(request.conversationId, request);
  const runtime = ClaudeRuntime.start(request.conversationId, request);
  if (request.conversationId) runtime.onWake = queueWakeTurn;
  return runtime;
}

/** The last turn queued per conversation; the next one starts when it settles. */
const turnQueues = new Map<string, Promise<unknown>>();

/** A turn the session started itself holds the conversation's queue like any other turn. */
function queueWakeTurn(request: TurnRequest, done: Promise<string>) {
  const { conversationId } = request;
  registerSessionConversation(request.sessionId, conversationId);
  const turn = Promise.allSettled([turnQueues.get(conversationId), done]);
  turnQueues.set(conversationId, turn);
  void turn.then(() => {
    if (turnQueues.get(conversationId) === turn) turnQueues.delete(conversationId);
  });
  // Dynamic: the chat handler imports the dispatcher, which imports this pool.
  void import("./wake.js").then(({ deliverWakeTurn }) => deliverWakeTurn(request, done));
}

/** A resume of a native session the CLI no longer has; retrying fresh is the fix. */
function isMissingSession(err: unknown): boolean {
  return err instanceof Error && /No conversation found with session ID/i.test(err.message);
}

/**
 * Run one turn on the conversation's live session, starting one if needed. A
 * conversation without an id (a one-off proactive run) gets a session that
 * closes when the turn ends.
 */
export async function runAgentTurn(provider: AgentProvider, request: TurnRequest): Promise<string> {
  if (!request.conversationId) return runOneOff(provider, request);
  // Never two turns on one session: a turn that arrives while another runs (a
  // race the WebSocket's steer did not catch, or another channel) waits for it.
  const previous = turnQueues.get(request.conversationId) ?? Promise.resolve();
  const turn = previous.catch(() => {}).then(() => runQueuedTurn(provider, request));
  turnQueues.set(request.conversationId, turn);
  try {
    return await turn;
  } finally {
    if (turnQueues.get(request.conversationId) === turn) turnQueues.delete(request.conversationId);
  }
}

async function runOneOff(provider: AgentProvider, request: TurnRequest): Promise<string> {
  const runtime = startRuntime(provider, request);
  try {
    return await runtime.runTurn(request);
  } finally {
    runtime.close();
  }
}

async function runQueuedTurn(provider: AgentProvider, request: TurnRequest): Promise<string> {
  let runtime = runtimes.get(request.conversationId);
  if (runtime && (runtime.provider !== provider || runtime.failed)) {
    closeConversationRuntime(request.conversationId);
    runtime = undefined;
  }
  if (!runtime) {
    runtime = startRuntime(provider, request);
    runtimes.set(request.conversationId, runtime);
  }

  try {
    return await runtime.runTurn(request);
  } catch (err) {
    if (provider === "claude" && isMissingSession(err)) {
      console.log("[runtime] Stale Claude session, starting fresh");
      closeConversationRuntime(request.conversationId);
      forgetClaudeSession(request.conversationId);
      const fresh = startRuntime(provider, request);
      runtimes.set(request.conversationId, fresh);
      return fresh.runTurn(request);
    }
    throw err;
  }
}

/** The running session of a conversation, if a turn is in progress. */
export function activeRuntime(conversationId: string): AgentRuntime | undefined {
  const runtime = runtimes.get(conversationId);
  return runtime?.busy ? runtime : undefined;
}

/**
 * The conversation's context use: read live from an idle session that can
 * answer (Claude), else what the last turn recorded.
 */
const LIVE_CONTEXT_MS = 1500;

export async function conversationContextUsage(conversationId: string): Promise<ContextUsage | null> {
  const runtime = runtimes.get(conversationId);
  if (runtime && !runtime.busy && !runtime.failed && runtime.contextUsage) {
    // A session that does not answer must not leave the ring blank: fall back to the saved reading.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_CONTEXT_MS).unref());
    const live = await Promise.race([runtime.contextUsage().catch(() => null), timeout]);
    if (live) return live;
  }
  return readContextUsage(conversationId);
}

export async function steerConversation(conversationId: string, text: string): Promise<boolean> {
  return (await activeRuntime(conversationId)?.steer(text)) ?? false;
}

export function answerApproval(conversationId: string, requestId: string, decision: ApprovalDecision): boolean {
  return runtimes.get(conversationId)?.answerApproval(requestId, decision) ?? false;
}

/** Fails closed: with no live session for the conversation, nobody can answer. */
export async function askForApproval(conversationId: string, question: ApprovalQuestion): Promise<ApprovalOutcome> {
  return runtimes.get(conversationId)?.requestApproval(question) ?? "expired";
}

export function closeAllRuntimes() {
  for (const conversationId of [...runtimes.keys()]) closeConversationRuntime(conversationId);
}

/** What a turn needs to be run again after a restart: the routing agent and the chat options. */
export interface ResumableTurn {
  agent: string;
  options: Record<string, unknown>;
}

/** Kept after the turn ends: a wake turn or an outliving subagent runs on the same session. */
const lastTurns = new Map<string, ResumableTurn>();
let shuttingDown = false;

/** Called by the dispatcher around a CLI turn, so a shutdown knows how to resume its session. */
/** What a chat's last turn ran with (provider, model, access…), while this process remembers it. */
export function lastTurnOptions(conversationId: string): Record<string, unknown> | undefined {
  return lastTurns.get(conversationId)?.options;
}

export function trackRunningTurn(conversationId: string, turn: ResumableTurn | null) {
  if (!conversationId) return;
  if (turn) {
    lastTurns.set(conversationId, turn);
    return;
  }
  // The turn has sent its notice. What runs after it on this session must not send it again.
  const last = lastTurns.get(conversationId);
  if (last) lastTurns.set(conversationId, { ...last, options: { ...last.options, notifyWhenDone: undefined } });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * On shutdown, save the sessions with work in progress: a running turn or a
 * subagent that outlived its turn. Truly idle sessions are never woken. Then
 * stop the CLIs. The startup resumes each saved session once (see resume.ts).
 */
export function suspendForShutdown(): number {
  shuttingDown = true;
  let saved = 0;
  for (const [conversationId, runtime] of runtimes) {
    const turn = lastTurns.get(conversationId);
    if (!turn || !(runtime.busy || runtime.hasLiveAgents)) continue;
    db.update(conversations).set({ resumeTurn: JSON.stringify(turn) }).where(eq(conversations.id, conversationId)).run();
    saved++;
  }
  closeAllRuntimes();
  return saved;
}
