import { execFileSync } from "child_process";
import { appendFile, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import type { AccessMode, ApprovalDecision, ContextUsage, SubagentStatus, TodoEntry } from "@chomp/shared";
import { db } from "../../db/index.js";
import { conversations } from "../../db/schema.js";
import { getAllSecrets } from "../../lib/secrets.js";
import { completeSession, persistRunningSession, registerKillCallback, registerSession, setLastActivity, touchSession } from "../registry.js";
import { listChatItems, TurnItems } from "./items.js";
import { invalidateUsage } from "./usage.js";
import { claudeContextUsage, saveContextUsage } from "./context.js";
import { waitForApproval, type ApprovalOutcome, type ApprovalQuestion } from "./approval.js";
import { approvalDetail, claudeApprovalSummary, claudeToolItem, claudeToolTitle, DECLINED_MESSAGE, toolResultText, withToolResult } from "./describe.js";
import { recordForkPoint, TurnInterruptedError, turnSessionStatus, type AgentRuntime, type TurnRequest } from "./types.js";

export type ClaudeAuthMode = "subscription" | "api-key";

export function normalizeClaudeAuthMode(value: unknown): ClaudeAuthMode {
  return value === "api-key" ? "api-key" : "subscription";
}

const ANTHROPIC_CREDENTIAL_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"]);

export function buildClaudeEnv(
  baseEnv: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
  authMode: ClaudeAuthMode,
  pointerKey: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, CHOMP_CC_SESSION_ID: pointerKey };

  // Remove Claude Code env vars to avoid the CLI nesting guard.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE")) delete env[key];
  }
  env.CHOMP_CC_SESSION_ID = pointerKey;

  if (authMode === "subscription") {
    // Let `claude` use its logged-in Claude.ai subscription. An API key in
    // process.env or in Chomp's secrets silently flips it to Console billing.
    for (const key of ANTHROPIC_CREDENTIAL_ENV_KEYS) delete env[key];
  }

  for (const [key, value] of Object.entries(secrets)) {
    if (authMode === "subscription" && ANTHROPIC_CREDENTIAL_ENV_KEYS.has(key)) continue;
    if (!env[key]) env[key] = value;
  }

  return env;
}

/**
 * The bridge (`mcp/bridge.mjs`) is spawned once per native session, so its env
 * cannot carry the per-turn Chomp session id. It reads this pointer instead,
 * which every turn rewrites before the prompt goes in — otherwise turn N's
 * `reply` and `ask_user` would land on turn 1's session.
 */
export function currentSessionPointerPath(pointerKey: string): string {
  return `/tmp/chomp-pty-current-session-${pointerKey}`;
}

export function writeCurrentSessionPointer(pointerKey: string, sessionId: string) {
  try {
    writeFileSync(currentSessionPointerPath(pointerKey), sessionId, "utf8");
  } catch (err) {
    console.warn("[runtime] Failed to write current-session pointer:", (err as Error).message);
  }
}

export function clearCurrentSessionPointer(pointerKey: string) {
  try {
    unlinkSync(currentSessionPointerPath(pointerKey));
  } catch {
    /* already gone */
  }
}

export const AGENT_LOG_DIR = join(homedir(), ".chomp", "agent-logs");
mkdirSync(AGENT_LOG_DIR, { recursive: true });

/** Where CLI agents work unless their config names a directory. */
export const DEFAULT_AGENT_CWD = join(homedir(), "chomp-work");
mkdirSync(DEFAULT_AGENT_CWD, { recursive: true });

let claudePath: string | undefined | null = null;

/** Run the user's own `claude` (the one they log in to) rather than the SDK's bundled copy. */
export function resolveClaudeExecutable(): string | undefined {
  if (claudePath !== null) return claudePath;
  try {
    claudePath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    claudePath = undefined;
  }
  return claudePath;
}

const PERMISSION_MODES: Record<AccessMode, PermissionMode> = {
  plan: "plan",
  supervised: "default",
  "auto-edits": "acceptEdits",
  full: "bypassPermissions",
};

const CLAUDE_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

function claudeEffort(effort: string | undefined): EffortLevel | undefined {
  return effort && CLAUDE_EFFORTS.has(effort) ? (effort as EffortLevel) : undefined;
}

/**
 * Plan mode ends when Claude calls ExitPlanMode with its plan. The timeline
 * shows the plan and the user implements it with their next message (in a
 * mode that allows changes), so the call is answered with a stop, not a yes.
 */
const PLAN_CAPTURED = "Chomp showed your plan to the user. Stop here and wait: they will reply with changes or ask you to implement it.";

/** The tool_use that carries the plan; its row would only duplicate the plan card. */
const EXIT_PLAN_TOOL = "ExitPlanMode";
/** Their calls show as the task checklist, not as rows. */
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
const ROWLESS_TOOLS = new Set([EXIT_PLAN_TOOL, ...TASK_TOOLS]);
/** What the session registry shows as the prompt of a turn Claude Code started itself. */
const WAKE_PROMPT = "(a background task finished)";

/** An async iterable the SDK reads user messages from, for as long as the session lives. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage) {
    this.queued.push(message);
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

interface ActiveTurn {
  request: TurnRequest;
  items: TurnItems;
  /** User messages (the prompt and any steers) the session has not answered yet. */
  pending: string[];
  /** False until the model starts on the prompt. A `now` steer sent before that
   *  jumps ahead of the prompt and is answered on its own, so steers wait here. */
  started: boolean;
  heldSteers: SDKUserMessage[];
  /** Steers Claude Code still holds in its queue; an answer that lists one has taken it in. */
  waitingSteers: Set<string>;
  /** The last main-thread assistant message: a fork of this turn starts after it. */
  lastAssistantUuid: string | null;
  finalText: string;
  /** Set while the agent tidies its task list after its reply (tidyTasks): that reply, which stays the turn's answer. */
  replyBeforeTidy?: string;
  interrupted: boolean;
  logPath: string;
  progress: NodeJS.Timeout;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

const tokensK = (n: number) => `${(n / 1000).toFixed(1)}k`;

function compactionSummary(before: number, after?: number): string {
  return after === undefined ? `Compacted the session (was ${tokensK(before)} tokens).` : `Compacted the session: ${tokensK(before)} → ${tokensK(after)} tokens.`;
}

function userMessage(text: string, uuid: string, priority?: SDKUserMessage["priority"]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: uuid as SDKUserMessage["uuid"],
    ...(priority ? { priority } : {}),
  };
}

const subagentId = (toolUseId: string) => `subagent:${toolUseId}`;

const TASK_STATUS: Record<string, SubagentStatus> = { completed: "completed", failed: "failed", stopped: "stopped" };

/**
 * Maps what a subagent does to items: its `task_*` events to one `subagent`
 * item, keyed by the Agent tool call that started it, and its own tool calls
 * to items under it. False for messages of the main thread.
 */
export function claudeSubagentMessage(items: TurnItems, message: SDKMessage): boolean {
  if (message.type === "system") {
    if (!message.subtype.startsWith("task_")) return false;
    if (!("tool_use_id" in message) || !message.tool_use_id) return true;
    const id = subagentId(message.tool_use_id);
    switch (message.subtype) {
      case "task_started":
        // Background shells and monitors are tasks too; only agents are subagents.
        if (message.task_type === "local_agent") {
          items.set(id, { kind: "subagent", name: message.subagent_type ?? "Agent", description: message.description, status: "running", toolUses: 0, tokens: 0, durationMs: 0 }, { immediate: true });
        }
        break;
      case "task_progress":
        items.patch(id, "subagent", {
          toolUses: message.usage.tool_uses,
          tokens: message.usage.total_tokens,
          durationMs: message.usage.duration_ms,
          lastActivity: message.description || message.last_tool_name,
          ...(message.summary ? { summary: message.summary } : {}),
        });
        break;
      case "task_notification":
        items.patch(
          id,
          "subagent",
          {
            status: TASK_STATUS[message.status] ?? "completed",
            summary: message.summary,
            ...(message.usage ? { toolUses: message.usage.tool_uses, tokens: message.usage.total_tokens, durationMs: message.usage.duration_ms } : {}),
          },
          { immediate: true },
        );
        break;
    }
    return true;
  }

  if (!("parent_tool_use_id" in message) || !message.parent_tool_use_id) return false;
  const parentId = subagentId(message.parent_tool_use_id);
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") items.set(block.id, claudeToolItem(block.name, (block.input ?? {}) as Record<string, unknown>), { parentId });
    }
  } else if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue;
      const current = items.get(block.tool_use_id);
      if (current) items.set(block.tool_use_id, withToolResult(current, toolResultText(block.content), !!block.is_error));
    }
  }
  // Its text and streamed deltas stay out: the panel shows what it did, and the summary.
  return true;
}

/**
 * One Claude Code session per conversation through the Agent SDK. Replaces the
 * PTY runner: no screen scraping and no `chomp_reply` requirement — the SDK
 * hands over typed messages and the final text arrives in the `result`.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly provider = "claude" as const;
  lastUsedAt = Date.now();

  private readonly input = new InputQueue();
  private readonly query: Query;
  private readonly approvals = new Map<string, (decision: ApprovalDecision | "expired") => void>();
  private turn: ActiveTurn | null = null;
  /** Subagents still running, by the Agent tool call that started them, with that call's turn. */
  private readonly liveAgents = new Map<string, ActiveTurn>();
  private lastRequest: TurnRequest | null = null;
  /** Set by the pool: delivers a turn Claude Code started on its own (see openWakeTurn). */
  onWake?: (request: TurnRequest, done: Promise<string>) => void;
  private dead: Error | null = null;
  private stderrTail = "";
  /** Text/thinking block → item id, keyed by `${messageId}:${index}` of the stream. */
  private readonly streamBlocks = new Map<string, string>();
  private streamMessageId: string | null = null;
  private readonly streamedMessages = new Set<string>();
  /** The session's task list (TaskCreate/TaskUpdate), which outlives the turn. */
  private readonly tasks = new Map<string, TodoEntry>();
  /** TaskCreate calls waiting for the id their result assigns. */
  private readonly taskCreates = new Map<string, string>();
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private fast: boolean;
  private access: AccessMode;

  private constructor(
    readonly conversationId: string,
    readonly ccSessionId: string,
    first: TurnRequest,
    resume: boolean,
  ) {
    this.model = first.model;
    this.effort = claudeEffort(first.effort);
    this.fast = !!first.fast;
    this.access = first.access;

    // Claude Code keeps a resumed session's tasks, so pick up the list the chat last showed. Without it,
    // updates to those tasks were dropped after every restart and the pinned list went stale.
    if (resume) {
      const shown = listChatItems(conversationId).filter((item) => item.kind === "todo_list").at(-1);
      for (const todo of shown?.todos ?? []) if (todo.id) this.tasks.set(todo.id, todo);
    }

    // A resumed session keeps the system prompt it was created with.
    const append = resume ? "" : first.systemPrompt ?? "";

    this.query = query({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        cwd: first.cwd,
        ...(resume ? { resume: ccSessionId } : { sessionId: ccSessionId }),
        model: this.model,
        effort: this.effort,
        ...(this.fast ? { settings: { fastMode: true } } : {}),
        thinking: { type: "adaptive", display: "summarized" },
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
        // Same sources the interactive CLI loads: the user's skills, plugins and
        // the globally registered chomp-api MCP bridge.
        settingSources: ["user", "project", "local"],
        permissionMode: PERMISSION_MODES[this.access],
        allowDangerouslySkipPermissions: true,
        // Chomp's own ask_user tool reaches every channel; the built-in one only
        // works for an SDK host that renders it.
        disallowedTools: ["AskUserQuestion"],
        // Talking to the user needs no permission from the user. send_imessage asks for itself, with the exact text.
        allowedTools: ["mcp__chomp-api__reply", "mcp__chomp-api__ask_user", "mcp__chomp-api__send_imessage"],
        canUseTool: this.canUseTool,
        hooks: { Stop: [{ hooks: [this.tidyTasks] }] },
        // CHOMP_CONVERSATION_ID lets a command the agent runs (such as a helper script) tell another agent where to answer.
        env: { ...buildClaudeEnv(process.env, getAllSecrets(), normalizeClaudeAuthMode(first.claudeAuthMode), ccSessionId), CHOMP_CONVERSATION_ID: first.conversationId, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" },
        stderr: (data) => {
          this.stderrTail = (this.stderrTail + data).slice(-4000);
        },
      },
    });
    void this.consume();
  }

  static start(conversationId: string, first: TurnRequest): ClaudeRuntime {
    const existing = conversationId ? getCcSessionId(conversationId) : null;
    const ccSessionId = existing ?? randomUUID();
    if (!existing && conversationId) setCcSessionId(conversationId, ccSessionId);
    console.log(`[claude] ${existing ? "Resuming" : "New"} session ${ccSessionId.slice(0, 8)} for conversation ${conversationId.slice(0, 8)}`);
    return new ClaudeRuntime(conversationId, ccSessionId, first, !!existing);
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  get hasLiveAgents(): boolean {
    return this.liveAgents.size > 0;
  }

  get failed(): Error | null {
    return this.dead;
  }

  async runTurn(request: TurnRequest): Promise<string> {
    if (this.dead) throw this.dead;
    if (this.turn) throw new Error("A turn is already running in this conversation");
    this.lastUsedAt = Date.now();
    await this.applySelection(request);
    this.lastRequest = request;
    const uuid = randomUUID();
    const done = this.openTurn(request, [uuid]);
    this.input.push(userMessage(request.prompt, uuid));
    return done;
  }

  /**
   * Claude Code starts a turn on its own when a background task (a shell, a
   * monitor, a subagent) finishes after the turn that started it ended. Give it
   * a turn like any other, in the last turn's chat, so its work and its answer
   * show up instead of being dropped. Null when there is nowhere to deliver it.
   */
  private openWakeTurn(): ActiveTurn | null {
    const last = this.lastRequest;
    if (!last || !this.onWake || this.dead) return null;
    const request: TurnRequest = { ...last, sessionId: randomUUID(), prompt: WAKE_PROMPT, userPrompt: undefined };
    const done = this.openTurn(request, []);
    this.onWake(request, done);
    return this.turn;
  }

  private openTurn(request: TurnRequest, pending: string[]): Promise<string> {
    const logPath = join(AGENT_LOG_DIR, `${request.sessionId}.sdk.jsonl`);
    registerSession({
      sessionId: request.sessionId,
      ccSessionId: this.ccSessionId,
      agentName: request.agentName,
      agentType: "claude-sdk",
      conversationId: request.conversationId || undefined,
      prompt: request.prompt,
      userPrompt: request.userPrompt,
      label: request.label,
      model: this.model,
      logPath,
      startedAt: Date.now(),
    });
    persistRunningSession(request.sessionId);
    registerKillCallback(request.sessionId, () => void this.interrupt());
    writeCurrentSessionPointer(this.ccSessionId, request.sessionId);

    const startedAt = Date.now();
    return new Promise<string>((resolve, reject) => {
      this.turn = {
        request,
        items: new TurnItems(request.conversationId, request.sessionId),
        pending,
        started: false,
        heldSteers: [],
        waitingSteers: new Set(),
        lastAssistantUuid: null,
        finalText: "",
        interrupted: false,
        logPath,
        progress: setInterval(() => {
          request.ctx.send({ type: "agent_progress", status: "working", elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
        }, 5000),
        resolve,
        reject,
      };
    });
  }

  async steer(text: string): Promise<boolean> {
    if (!this.turn || this.dead) return false;
    const uuid = randomUUID();
    this.turn.pending.push(uuid);
    this.turn.waitingSteers.add(uuid);
    // `next` folds it in at the next tool boundary too, and unlike `now` it lets an
    // interrupt kill a running tool, which is what Send now (hurry) relies on.
    const message = userMessage(text, uuid, "next");
    // A steer gets an answer of its own, so what comes next is shown again.
    this.turn.replyBeforeTidy = undefined;
    if (this.turn.started) this.input.push(message);
    else this.turn.heldSteers.push(message);
    return true;
  }

  /** Send now: stop the current step so the waiting steers run at once. The turn goes on. */
  async hurry(): Promise<boolean> {
    // shortcut: a steer held before the model starts is not hurried; it goes in as soon as the model starts anyway.
    if (!this.turn?.started || this.turn.waitingSteers.size === 0) return false;
    await this.query.interrupt().catch((err) => console.warn("[claude] hurry failed:", (err as Error).message));
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.turn) return;
    this.turn.interrupted = true;
    for (const resolve of this.approvals.values()) resolve("expired");
    await this.query.interrupt().catch((err) => console.warn("[claude] interrupt failed:", (err as Error).message));
  }

  answerApproval(requestId: string, decision: ApprovalDecision): boolean {
    const resolve = this.approvals.get(requestId);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  async requestApproval({ title, detail, summary, readFirst }: ApprovalQuestion): Promise<ApprovalOutcome> {
    const turn = this.turn;
    if (!turn) return "expired";
    const requestId = randomUUID();
    const itemId = `approval:${requestId}`;
    turn.items.set(itemId, { kind: "approval", requestId, title, detail, state: "pending", oneTime: true }, { immediate: true });
    const answer = await waitForApproval(turn.request, requestId, summary, (resolve) => this.approvals.set(requestId, resolve), { readFirst });
    this.approvals.delete(requestId);
    const decision = this.turn === turn ? answer : "expired";
    turn.items.patch(itemId, "approval", { state: decision }, { immediate: true });
    return decision;
  }

  /** The /context breakdown of the live session; "summary" skips the per-category token counts. */
  async contextUsage(): Promise<ContextUsage | null> {
    if (this.dead) return null;
    const usage = claudeContextUsage(await this.query.getContextUsage({ detail: "summary" }));
    saveContextUsage(this.conversationId, usage);
    return usage;
  }

  close() {
    this.stopLiveAgents();
    this.input.close();
    this.query.close();
    clearCurrentSessionPointer(this.ccSessionId);
  }

  private async applySelection(request: TurnRequest) {
    if (request.model && request.model !== this.model) {
      await this.query.setModel(request.model);
      this.model = request.model;
    }
    const effort = claudeEffort(request.effort);
    const fast = !!request.fast;
    if (effort !== this.effort || fast !== this.fast) {
      await this.query.applyFlagSettings({ effortLevel: effort ?? null, fastMode: fast });
      this.effort = effort;
      this.fast = fast;
    }
    if (request.access !== this.access) {
      await this.query.setPermissionMode(PERMISSION_MODES[request.access]);
      this.access = request.access;
    }
  }

  /**
   * Agents forget their task list once the work is done, and it stays pinned in the chat with tasks open.
   * So a turn about to end with open tasks goes on once more, only to update the list.
   */
  private readonly tidyTasks: HookCallback = async (input) => {
    const turn = this.turn;
    if (!turn || turn.interrupted || turn.waitingSteers.size > 0 || input.hook_event_name !== "Stop" || input.stop_hook_active) return {};
    // Work still running in the background wakes the session later: its tasks really are in progress.
    if (input.background_tasks?.length || input.session_crons?.length) return {};
    const open = [...this.tasks].filter(([, task]) => task.status !== "completed");
    const touched = turn.items.get(`todos:${turn.request.sessionId}`) !== undefined;
    if (open.length === 0 || !(touched || open.some(([, task]) => task.status === "in_progress"))) return {};
    turn.replyBeforeTidy = input.last_assistant_message ?? "";
    return {
      decision: "block",
      reason: [
        "Chomp: your reply above is kept and delivered as written. Before the turn ends, bring your task list up to date. The user sees it pinned in the chat, and it still shows these tasks as open:",
        ...open.map(([id, task]) => `#${id} [${task.status}] ${task.text}`),
        "With TaskUpdate, set what is done to `completed`, delete what no longer applies, and set what is still open (for example waiting for the user) to `pending`. Nothing is `in_progress` once you stop. Do no other work and write nothing more: text after this is not shown.",
      ].join("\n"),
    };
  };

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal, suggestions, title, displayName }) => {
    const turn = this.turn;
    if (!turn) return { behavior: "deny", message: "No turn is running." };
    if (toolName === EXIT_PLAN_TOOL) {
      const plan = typeof input.plan === "string" ? input.plan.trim() : "";
      if (plan) turn.items.set(`plan:${randomUUID()}`, { kind: "proposed_plan", markdown: plan }, { immediate: true });
      return { behavior: "deny", message: PLAN_CAPTURED };
    }
    const requestId = randomUUID();
    const itemId = `approval:${requestId}`;
    turn.items.set(
      itemId,
      { kind: "approval", requestId, title: title ?? `Allow ${displayName ?? claudeToolTitle(toolName, input)}`, detail: approvalDetail(toolName, input), state: "pending" },
      { immediate: true },
    );
    const decision = await waitForApproval(turn.request, requestId, claudeApprovalSummary(toolName, input), (resolve) => {
      this.approvals.set(requestId, resolve);
      signal.addEventListener("abort", () => resolve("expired"), { once: true });
    });
    this.approvals.delete(requestId);
    turn.items.patch(itemId, "approval", { state: decision }, { immediate: true });

    const allow = (extra?: Partial<PermissionResult>): PermissionResult => ({ behavior: "allow", updatedInput: input, ...extra }) as PermissionResult;
    if (decision === "accept") return allow();
    if (decision === "accept-session") {
      return allow({ updatedPermissions: (suggestions ?? []).map((update) => ({ ...update, destination: "session" as const })) });
    }
    return { behavior: "deny", message: decision === "expired" ? "The approval request expired: nobody answered, or the user's phone could not be reached." : DECLINED_MESSAGE };
  };

  private async consume() {
    try {
      for await (const message of this.query) this.handle(message);
      this.fail(new Error(this.exitMessage("Claude Code session ended")));
    } catch (err) {
      this.fail(new Error(this.exitMessage(err instanceof Error ? err.message : String(err))));
    }
  }

  private exitMessage(reason: string): string {
    const stderr = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
    return stderr ? `${reason}: ${stderr}` : reason;
  }

  private fail(err: Error) {
    this.dead = err;
    for (const resolve of this.approvals.values()) resolve("expired");
    this.stopLiveAgents();
    if (this.turn) this.finish(this.turn.interrupted ? new TurnInterruptedError() : err);
  }

  private finish(outcome: string | Error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.lastUsedAt = Date.now();
    clearInterval(turn.progress);
    const failed = outcome instanceof Error;
    this.settleTurn(turn, failed ? "failed" : "completed");
    completeSession(turn.request.sessionId, turnSessionStatus(outcome), failed ? outcome.message : undefined);
    recordForkPoint(turn.request.sessionId, turn.lastAssistantUuid, turn.request.cwd);
    // Kept for the context meter, which also reads it after the session has closed.
    if (this.conversationId) this.contextUsage().catch((err) => console.warn("[claude] context usage failed:", (err as Error).message));
    if (failed) turn.reject(outcome);
    else turn.resolve(outcome);
  }

  /** Close what the turn left open, except subagents still running: they report their own end. */
  private settleTurn(turn: ActiveTurn, outcome: "completed" | "failed") {
    turn.items.settle(outcome, [...this.liveAgents.keys()].map(subagentId));
  }

  /** The session is going, and its subagents go with it. */
  private stopLiveAgents() {
    for (const { items } of this.liveAgents.values()) items.settle("failed");
    this.liveAgents.clear();
  }

  /**
   * The turn a subagent's message belongs to: the one that started it, which may
   * have ended, since a background subagent outlives its turn.
   * shortcut: a subagent resumed by SendMessage labels its own tool calls with its first
   * tool_use_id, so those calls are not shown; its row is still right. Map task_id if that matters.
   */
  private agentTurn(message: SDKMessage): ActiveTurn | undefined {
    if (message.type !== "system") {
      return "parent_tool_use_id" in message && message.parent_tool_use_id ? this.liveAgents.get(message.parent_tool_use_id) : undefined;
    }
    if ((message.subtype !== "task_started" && message.subtype !== "task_progress" && message.subtype !== "task_notification") || !message.tool_use_id) return undefined;
    if (message.subtype === "task_started" && message.task_type === "local_agent" && this.turn) this.liveAgents.set(message.tool_use_id, this.turn);
    const owner = this.liveAgents.get(message.tool_use_id);
    if (message.subtype === "task_notification" && this.liveAgents.delete(message.tool_use_id)) {
      // Its wake turn is about to start; the idle sweep must not beat it.
      this.lastUsedAt = Date.now();
    }
    return owner;
  }

  private handle(message: SDKMessage) {
    if (message.type === "rate_limit_event") invalidateUsage("claude");
    const startsAnswer = message.type === "stream_event" || message.type === "assistant";
    const mainThread = !("parent_tool_use_id" in message && message.parent_tool_use_id);
    const turn = this.agentTurn(message) ?? this.turn ?? (startsAnswer && mainThread ? this.openWakeTurn() : null);
    if (!turn) return;
    appendFile(turn.logPath, `${JSON.stringify(message)}\n`, () => {});
    if (this.turn) touchSession(this.turn.request.sessionId);
    // The timeline shows the main thread; what subagents do goes to the chat info panel.
    if (claudeSubagentMessage(turn.items, message)) {
      // An open turn settles itself; nothing else closes the calls a subagent left open after its turn.
      if (turn !== this.turn && message.type === "system" && message.subtype === "task_notification") this.settleTurn(turn, "completed");
      return;
    }

    if (!turn.started && startsAnswer) {
      turn.started = true;
      for (const steer of turn.heldSteers.splice(0)) this.input.push(steer);
    }
    const taken = "user_message_uuids" in message ? message.user_message_uuids : undefined;
    if (mainThread && taken && turn.waitingSteers.size > 0) {
      for (const uuid of taken) turn.waitingSteers.delete(uuid);
      if (turn.waitingSteers.size === 0) turn.request.ctx.send({ type: "steers_taken" });
    }

    switch (message.type) {
      case "stream_event":
        this.handleStreamEvent(turn, message.event);
        break;
      case "assistant": {
        const id = message.message.id;
        turn.lastAssistantUuid = message.uuid;
        if (message.error) turn.items.set(`error:${message.uuid}`, { kind: "error", message: `Claude API error: ${message.error}` });
        for (const [index, block] of message.message.content.entries()) {
          if (block.type === "tool_use" && TASK_TOOLS.has(block.name)) {
            this.trackTask(turn, block.id, block.name, (block.input ?? {}) as Record<string, unknown>);
          } else if (block.type === "tool_use" && block.name !== EXIT_PLAN_TOOL) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            turn.items.set(block.id, claudeToolItem(block.name, input));
            const summary = claudeToolTitle(block.name, input);
            setLastActivity(turn.request.sessionId, { tool: block.name, summary });
            turn.request.ctx.send({ type: "agent_activity", sessionId: turn.request.sessionId, tool: block.name, summary });
          } else if (!this.streamedMessages.has(id) && block.type === "text" && block.text.trim() && turn.replyBeforeTidy === undefined) {
            // Only when no stream events arrived for this message (they own text otherwise).
            turn.items.set(`${id}:${index}`, { kind: "assistant_text", text: block.text, streaming: false });
          }
        }
        break;
      }
      case "user": {
        const content = message.message.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const subject = this.taskCreates.get(block.tool_use_id);
          const taskId = (message.tool_use_result as { task?: { id?: unknown } } | undefined)?.task?.id;
          if (subject !== undefined && typeof taskId === "string") {
            this.taskCreates.delete(block.tool_use_id);
            this.tasks.set(taskId, { id: taskId, text: subject, status: "pending" });
            this.showTasks(turn);
          }
          const current = turn.items.get(block.tool_use_id);
          if (!current) continue;
          turn.items.set(block.tool_use_id, withToolResult(current, toolResultText(block.content), !!block.is_error));
        }
        break;
      }
      case "result": {
        const covered = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : []);
        // Claude Code answers its own task notifications too, like the orphaned tasks a
        // resumed session reports before it reads the prompt. That does not answer the prompt.
        if (message.origin?.kind === "task-notification" && covered.length === 0 && turn.pending.length > 0) break;
        turn.pending = covered.length > 0 ? turn.pending.filter((uuid) => !covered.includes(uuid)) : turn.pending.slice(1);
        const kept = turn.replyBeforeTidy;
        turn.replyBeforeTidy = undefined;
        if (message.subtype === "success") {
          const reply = kept ?? message.result;
          if (reply.trim()) turn.finalText = reply;
        } else if (!turn.interrupted && turn.pending.length === 0) {
          this.finish(new Error(message.errors.join("; ") || `Claude Code turn failed (${message.subtype})`));
          return;
        }
        // A steer that lands mid-answer makes Claude Code abort that answer with an
        // error result, then answer again with the steer. The turn goes on.
        if (turn.interrupted) this.finish(new TurnInterruptedError());
        else if (turn.pending.length === 0) this.finish(turn.finalText);
        break;
      }
      case "system":
        // /compact answers with an empty result; this is the reply. An automatic compaction mid-turn stays silent.
        if (message.subtype === "compact_boundary" && message.compact_metadata.trigger === "manual") {
          turn.finalText = compactionSummary(message.compact_metadata.pre_tokens, message.compact_metadata.post_tokens);
        }
        break;
      default:
        break;
    }
  }

  /** Task tools become one live checklist per turn instead of a row per call. */
  private trackTask(turn: ActiveTurn, toolUseId: string, name: string, input: Record<string, unknown>) {
    if (name === "TaskCreate") {
      this.taskCreates.set(toolUseId, String(input.subject ?? ""));
      return;
    }
    const task = this.tasks.get(String(input.taskId));
    if (!task) return;
    if (input.status === "deleted") this.tasks.delete(String(input.taskId));
    else {
      if (typeof input.subject === "string") task.text = input.subject;
      const status = (["pending", "in_progress", "completed"] as const).find((s) => s === input.status);
      if (status) task.status = status;
    }
    this.showTasks(turn);
  }

  private showTasks(turn: ActiveTurn) {
    turn.items.set(`todos:${turn.request.sessionId}`, { kind: "todo_list", todos: [...this.tasks.values()].map((t) => ({ ...t })) });
  }

  private handleStreamEvent(turn: ActiveTurn, event: Extract<SDKMessage, { type: "stream_event" }>["event"]) {
    switch (event.type) {
      case "message_start":
        this.streamMessageId = event.message.id;
        this.streamedMessages.add(event.message.id);
        break;
      case "content_block_start": {
        const key = `${this.streamMessageId}:${event.index}`;
        const block = event.content_block;
        if ((block.type === "text" && turn.replyBeforeTidy === undefined) || block.type === "thinking") {
          this.streamBlocks.set(key, key);
        } else if (block.type === "tool_use" && !ROWLESS_TOOLS.has(block.name)) {
          turn.items.set(block.id, { kind: "tool_call", tool: block.name, title: claudeToolTitle(block.name, {}), status: "running" });
        }
        break;
      }
      case "content_block_delta": {
        const itemId = this.streamBlocks.get(`${this.streamMessageId}:${event.index}`);
        if (!itemId) break;
        if (event.delta.type === "text_delta") turn.items.appendText(itemId, "assistant_text", event.delta.text);
        else if (event.delta.type === "thinking_delta") turn.items.appendText(itemId, "reasoning", event.delta.thinking);
        break;
      }
      case "content_block_stop": {
        const key = `${this.streamMessageId}:${event.index}`;
        const itemId = this.streamBlocks.get(key);
        if (!itemId) break;
        this.streamBlocks.delete(key);
        const body = turn.items.get(itemId);
        if (body && "streaming" in body) turn.items.set(itemId, { ...body, streaming: false });
        break;
      }
      default:
        break;
    }
  }
}

function getCcSessionId(conversationId: string): string | null {
  return db.select({ id: conversations.ccSessionId }).from(conversations).where(eq(conversations.id, conversationId)).get()?.id ?? null;
}

function setCcSessionId(conversationId: string, ccSessionId: string | null) {
  db.update(conversations).set({ ccSessionId }).where(eq(conversations.id, conversationId)).run();
}

/** A resume of a session Claude Code no longer has fails at start; forget it so the retry starts fresh. */
export function forgetClaudeSession(conversationId: string) {
  if (conversationId) setCcSessionId(conversationId, null);
}
