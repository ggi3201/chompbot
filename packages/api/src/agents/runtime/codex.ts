import { randomUUID } from "crypto";
import { appendFile } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import type { AccessMode, ApprovalDecision, ChatItemBody, FileDiff, SubagentStatus } from "@chomp/shared";
import { db } from "../../db/index.js";
import { conversations } from "../../db/schema.js";
import { getAllSecrets } from "../../lib/secrets.js";
import { completeSession, persistRunningSession, registerKillCallback, registerSession, setLastActivity, touchSession } from "../registry.js";
import { TurnItems } from "./items.js";
import { invalidateUsage } from "./usage.js";
import { codexContextUsage, saveContextUsage } from "./context.js";
import { waitForApproval, type ApprovalOutcome, type ApprovalQuestion } from "./approval.js";
import { clipOutput, codexApprovalSummary, countDiff, diffFile, splitProposedPlan } from "./describe.js";
import { AGENT_LOG_DIR, clearCurrentSessionPointer, writeCurrentSessionPointer } from "./claude.js";
import { CodexRpc, type CodexServerRequest } from "./codex-rpc.js";
import { recordForkPoint, TurnInterruptedError, turnSessionStatus, type AgentRuntime, type TurnRequest } from "./types.js";

type Params = Record<string, unknown>;
type CodexItem = { type: string; id: string } & Params;

/** Access mode → Codex approval policy and sandbox, the same mapping T3 Code uses. */
const ACCESS_POLICY: Record<AccessMode, { approvalPolicy: string; sandbox: string; sandboxPolicy: Params }> = {
  // Plan reads freely; the read-only sandbox is what keeps it from changing anything.
  plan: { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: true } },
  supervised: { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: true } },
  "auto-edits": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  full: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
};

const ITEM_STATUS: Record<string, "running" | "completed" | "failed" | "declined"> = {
  inProgress: "running",
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

const PLAN_STATUS: Record<string, "pending" | "in_progress" | "completed"> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

const COMMAND_DECISION: Record<ApprovalDecision | "expired", string> = {
  accept: "accept",
  "accept-session": "acceptForSession",
  decline: "decline",
  expired: "cancel",
};

const LEGACY_DECISION: Record<ApprovalDecision | "expired", string> = {
  accept: "approved",
  "accept-session": "approved_for_session",
  decline: "abort",
  expired: "abort",
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

/** Codex sends a unified diff for an update but the plain file content for an add or delete. */
function codexFileDiff(change: { path: string; kind: { type: string }; diff: string }): FileDiff {
  if (change.kind?.type === "add") return diffFile(change.path, "", change.diff, "add");
  if (change.kind?.type === "delete") return diffFile(change.path, change.diff, "", "delete");
  return countDiff(change.path, change.diff, "update");
}

/** Map one Codex thread item to the timeline's shape; null for kinds the timeline skips. */
export function codexItemBody(item: CodexItem): ChatItemBody | null {
  const status = ITEM_STATUS[str(item.status)] ?? "completed";
  switch (item.type) {
    case "agentMessage":
      return { kind: "assistant_text", text: str(item.text), streaming: false };
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? (item.summary as string[]).join("\n\n") : "";
      const content = Array.isArray(item.content) ? (item.content as string[]).join("\n\n") : "";
      const text = summary || content;
      return text ? { kind: "reasoning", text, streaming: false } : null;
    }
    case "commandExecution":
      return {
        kind: "command",
        command: str(item.command),
        cwd: str(item.cwd) || undefined,
        output: clipOutput(str(item.aggregatedOutput)),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        status,
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path: string; kind: { type: string }; diff: string }>) : [];
      return { kind: "file_change", files: changes.map(codexFileDiff), status };
    }
    case "mcpToolCall": {
      const result = item.result as { content?: Array<{ text?: string }> } | null;
      const error = item.error as { message?: string } | null;
      const output = error?.message ?? (result?.content ?? []).map((c) => c.text ?? "").filter(Boolean).join("\n");
      return {
        kind: "tool_call",
        tool: `mcp__${str(item.server)}__${str(item.tool)}`,
        title: `${str(item.tool).replace(/_/g, " ")} (${str(item.server)})`,
        input: item.arguments ? JSON.stringify(item.arguments, null, 2) : undefined,
        output: output ? clipOutput(output) : undefined,
        status,
      };
    }
    case "dynamicToolCall": {
      const contentItems = Array.isArray(item.contentItems) ? (item.contentItems as Array<{ text?: string }>) : [];
      const output = contentItems.map((c) => c.text ?? "").filter(Boolean).join("\n");
      return {
        kind: "tool_call",
        tool: str(item.tool),
        title: str(item.tool),
        input: item.arguments ? JSON.stringify(item.arguments, null, 2) : undefined,
        output: output ? clipOutput(output) : undefined,
        status,
      };
    }
    case "plan":
      return str(item.text).trim() ? { kind: "proposed_plan", markdown: str(item.text) } : null;
    case "webSearch":
      return { kind: "tool_call", tool: "web_search", title: `Search the web: ${str(item.query)}`, status: item.results ? "completed" : "running" };
    default:
      return null;
  }
}

const AGENT_STATUS: Record<string, SubagentStatus> = {
  pendingInit: "running",
  running: "running",
  completed: "completed",
  errored: "failed",
  notFound: "failed",
  interrupted: "stopped",
  shutdown: "stopped",
};

/**
 * A `collabAgentToolCall` (spawnAgent, wait, closeAgent, …) reports the state
 * of the agents it touched. Each agent is one `subagent` item, keyed by its
 * thread: the spawn creates it, every later call updates it.
 */
export function codexCollabItems(items: TurnItems, item: CodexItem) {
  const states = (item.agentsStates ?? {}) as Record<string, { status: string; message: string | null } | undefined>;
  for (const [threadId, state] of Object.entries(states)) {
    if (!state) continue;
    const id = `subagent:${threadId}`;
    const fields = { status: AGENT_STATUS[state.status] ?? "running", ...(state.message ? { summary: state.message } : {}) };
    if (item.tool === "spawnAgent" && !items.has(id)) {
      const description = str(item.prompt).split("\n")[0].slice(0, 120);
      items.set(id, { kind: "subagent", name: str(item.model) || "Agent", description, toolUses: 0, tokens: 0, durationMs: 0, ...fields });
    } else {
      items.patch(id, "subagent", fields);
    }
  }
}

/** `subAgentActivity.kind` → status. Codex's stable multi_agent feature reports subagents this way. */
const ACTIVITY_STATUS: Record<string, SubagentStatus> = { started: "running", interacted: "running", completed: "completed", interrupted: "stopped" };

function workTitle(body: Extract<ChatItemBody, { kind: "command" | "tool_call" | "file_change" }>): string {
  if (body.kind === "command") return body.command;
  if (body.kind === "tool_call") return body.title;
  return "Editing files";
}

/**
 * The app-server streams a subagent's own thread on the same connection. Its
 * work goes under its `subagent` item, its last message becomes the summary,
 * and none of it reaches the main timeline. False for the main thread's own events.
 */
export function codexSubagentNotification(items: TurnItems, mainThreadId: string, method: string, params: Params): boolean {
  const item = params.item as CodexItem | undefined;
  const threadId = str(params.threadId);
  if (threadId && threadId !== mainThreadId) {
    const parentId = `subagent:${threadId}`;
    if (method === "thread/tokenUsage/updated") {
      const total = (params.tokenUsage as { total?: { totalTokens?: number } } | undefined)?.total?.totalTokens;
      if (total) items.patch(parentId, "subagent", { tokens: total });
    }
    if (!item || (method !== "item/started" && method !== "item/completed")) return true;
    const body = codexItemBody(item);
    if (body?.kind === "command" || body?.kind === "tool_call" || body?.kind === "file_change") {
      const subagent = items.get(parentId);
      if (method === "item/started" && !items.has(item.id) && subagent?.kind === "subagent") {
        items.patch(parentId, "subagent", { toolUses: subagent.toolUses + 1, lastActivity: workTitle(body) });
      }
      items.set(item.id, body, { parentId });
    } else if (method === "item/completed" && body?.kind === "assistant_text" && body.text.trim()) {
      items.patch(parentId, "subagent", { summary: body.text });
    }
    return true;
  }

  if (item?.type === "subAgentActivity") {
    const id = `subagent:${str(item.agentThreadId)}`;
    const status = ACTIVITY_STATUS[str(item.kind)] ?? "running";
    if (items.has(id)) {
      items.patch(id, "subagent", { status }, { immediate: true });
    } else {
      const description = (str(item.agentPath).split("/").pop() ?? "").replace(/_/g, " ");
      items.set(id, { kind: "subagent", name: "Agent", description, status, toolUses: 0, tokens: 0, durationMs: 0 }, { immediate: true });
    }
    return true;
  }
  if (item?.type === "collabAgentToolCall") {
    codexCollabItems(items, item);
    return true;
  }
  return false;
}

interface ActiveTurn {
  request: TurnRequest;
  items: TurnItems;
  codexTurnId: string | null;
  finalText: string;
  interrupted: boolean;
  logPath: string;
  progress: NodeJS.Timeout;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/**
 * One `codex app-server` per conversation. Replaces `codex exec --json`: the
 * process stays up between turns, streams item deltas, asks for approvals and
 * takes steers into a running turn.
 */
export class CodexRuntime implements AgentRuntime {
  readonly provider = "codex" as const;
  lastUsedAt = Date.now();

  private readonly rpc: CodexRpc;
  private readonly ready: Promise<string>;
  private readonly approvals = new Map<string, (decision: ApprovalDecision | "expired") => void>();
  private readonly pointerKey: string;
  private turn: ActiveTurn | null = null;
  private dead: Error | null = null;
  private fast = false;
  /** The thread's model; plan mode's collaboration settings must name one. */
  private model: string | null = null;
  /** The main thread; events of any other thread on this connection are a subagent's. */
  private threadId: string | null = null;

  private constructor(readonly conversationId: string, first: TurnRequest) {
    this.pointerKey = `codex-${conversationId}`;
    const env: NodeJS.ProcessEnv = { ...process.env, CHOMP_CONVERSATION_ID: conversationId };
    for (const [key, value] of Object.entries(getAllSecrets())) env[key] ??= value;
    // Codex does not hand its env to MCP servers; set the bridge's pointer key in its config instead.
    this.rpc = new CodexRpc(["-c", `mcp_servers.chomp-api.env.CHOMP_CC_SESSION_ID="${this.pointerKey}"`], { cwd: first.cwd, env });
    this.rpc.onNotification = (method, params) => this.handleNotification(method, params);
    this.rpc.onServerRequest = (request) => void this.handleServerRequest(request);
    this.rpc.onExit = (err) => this.fail(err);
    this.ready = this.openThread(first);
    this.ready.then((threadId) => (this.threadId = threadId), () => {});
    this.ready.catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
  }

  static start(conversationId: string, first: TurnRequest): CodexRuntime {
    return new CodexRuntime(conversationId, first);
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  get failed(): Error | null {
    return this.dead;
  }

  private async openThread(first: TurnRequest): Promise<string> {
    await this.rpc.request("initialize", { clientInfo: { name: "chomp", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.rpc.notify("initialized");

    const policy = ACCESS_POLICY[first.access];
    const existing = this.conversationId ? getCodexThreadId(this.conversationId) : null;
    if (existing) {
      try {
        const resumed = await this.rpc.request<{ thread: { id: string }; model: string }>("thread/resume", {
          threadId: existing,
          cwd: first.cwd,
          model: first.model,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
        });
        console.log(`[codex] Resumed thread ${existing.slice(0, 8)}`);
        this.model = resumed.model;
        return resumed.thread.id;
      } catch (err) {
        console.log(`[codex] Thread ${existing.slice(0, 8)} did not resume (${(err as Error).message}); starting fresh`);
      }
    }
    const started = await this.rpc.request<{ thread: { id: string }; model: string }>("thread/start", {
      cwd: first.cwd,
      model: first.model,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: first.systemPrompt || null,
      serviceName: "chomp",
    });
    this.model = started.model;
    if (this.conversationId) setCodexThreadId(this.conversationId, started.thread.id);
    console.log(`[codex] New thread ${started.thread.id.slice(0, 8)}`);
    return started.thread.id;
  }

  async runTurn(request: TurnRequest): Promise<string> {
    if (this.dead) throw this.dead;
    if (this.turn) throw new Error("A turn is already running in this conversation");
    this.lastUsedAt = Date.now();
    const threadId = await this.ready;

    const logPath = join(AGENT_LOG_DIR, `${request.sessionId}.codex.jsonl`);
    registerSession({
      sessionId: request.sessionId,
      ccSessionId: threadId,
      agentName: request.agentName,
      agentType: "codex-sdk",
      conversationId: request.conversationId || undefined,
      pid: this.rpc.pid,
      prompt: request.prompt,
      userPrompt: request.userPrompt,
      label: request.label,
      model: request.model,
      logPath,
      startedAt: Date.now(),
    });
    persistRunningSession(request.sessionId);
    registerKillCallback(request.sessionId, () => void this.interrupt());
    writeCurrentSessionPointer(this.pointerKey, request.sessionId);

    const startedAt = Date.now();
    const done = new Promise<string>((resolve, reject) => {
      this.turn = {
        request,
        items: new TurnItems(request.conversationId, request.sessionId),
        codexTurnId: null,
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

    const policy = ACCESS_POLICY[request.access];
    const fast = !!request.fast;
    try {
      const started = await this.rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: textInput(request.prompt),
        model: request.model ?? null,
        effort: request.effort ?? null,
        summary: "auto",
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(fast !== this.fast || fast ? { serviceTier: fast ? "priority" : null } : {}),
        // Sent every turn, not only in plan mode, so leaving Plan switches it off.
        // No developer_instructions: that would replace the ones the thread started with.
        collaborationMode: {
          mode: request.access === "plan" ? "plan" : "default",
          settings: { model: request.model ?? this.model, ...(request.effort ? { reasoning_effort: request.effort } : {}) },
        },
      });
      if (request.model) this.model = request.model;
      this.fast = fast;
      // `turn/started` may have set it already; the field is narrowed away by TS after the closure assignment.
      const current = this.turn as ActiveTurn | null;
      if (current) current.codexTurnId ??= started.turn.id;
    } catch (err) {
      this.finish(err instanceof Error ? err : new Error(String(err)));
    }
    return done;
  }

  async steer(text: string): Promise<boolean> {
    const turn = this.turn;
    if (!turn?.codexTurnId || this.dead) return false;
    const threadId = await this.ready;
    try {
      await this.rpc.request("turn/steer", { threadId, input: textInput(text), expectedTurnId: turn.codexTurnId });
      return true;
    } catch (err) {
      console.warn("[codex] steer failed:", (err as Error).message);
      return false;
    }
  }

  // shortcut: Codex folds a steer into its next model call and has no queue to hurry; add one if Codex steers start waiting on long commands.
  async hurry(): Promise<boolean> {
    return false;
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.interrupted = true;
    for (const resolve of this.approvals.values()) resolve("expired");
    if (!turn.codexTurnId) return this.finish(new TurnInterruptedError());
    const threadId = await this.ready;
    await this.rpc.request("turn/interrupt", { threadId, turnId: turn.codexTurnId }).catch((err) => {
      console.warn("[codex] interrupt failed:", (err as Error).message);
      this.finish(new TurnInterruptedError());
    });
  }

  answerApproval(requestId: string, decision: ApprovalDecision): boolean {
    const resolve = this.approvals.get(requestId);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  close() {
    this.rpc.close();
    clearCurrentSessionPointer(this.pointerKey);
  }

  private fail(err: Error) {
    if (this.dead) return;
    this.dead = err;
    for (const resolve of this.approvals.values()) resolve("expired");
    if (this.turn) this.finish(this.turn.interrupted ? new TurnInterruptedError() : err);
  }

  private finish(outcome: string | Error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.lastUsedAt = Date.now();
    clearInterval(turn.progress);
    const failed = outcome instanceof Error;
    turn.items.settle(failed ? "failed" : "completed");
    completeSession(turn.request.sessionId, turnSessionStatus(outcome), failed ? outcome.message : undefined);
    recordForkPoint(turn.request.sessionId, turn.codexTurnId, turn.request.cwd);
    if (failed) turn.reject(outcome);
    else turn.resolve(outcome);
  }

  private handleNotification(method: string, params: Params) {
    if (method === "account/rateLimits/updated") invalidateUsage("codex");
    // A subagent's thread reports its own usage; the context meter is the main thread's.
    if (method === "thread/tokenUsage/updated" && (!this.threadId || params.threadId === this.threadId)) {
      const usage = codexContextUsage(params.tokenUsage as Parameters<typeof codexContextUsage>[0], this.model ?? undefined);
      if (usage) saveContextUsage(this.conversationId, usage);
    }
    const turn = this.turn;
    if (!turn) return;
    appendFile(turn.logPath, `${JSON.stringify({ method, params })}\n`, () => {});
    touchSession(turn.request.sessionId);
    const itemId = str(params.itemId);
    if (this.threadId && codexSubagentNotification(turn.items, this.threadId, method, params)) return;

    switch (method) {
      case "turn/started":
        turn.codexTurnId ??= str((params.turn as Params)?.id);
        break;
      case "item/started":
      case "item/completed": {
        const item = params.item as CodexItem;
        const body = codexItemBody(item);
        if (!body) break;
        const existing = turn.items.get(item.id);
        if (method === "item/completed" && body.kind === "assistant_text") {
          const { text, plan } = splitProposedPlan(body.text);
          turn.items.set(item.id, { ...body, text });
          if (plan) turn.items.set(`plan:${item.id}`, { kind: "proposed_plan", markdown: plan });
          if (text.trim()) turn.finalText = text;
          break;
        }
        // Streamed text already holds the deltas; the completed item carries the full text.
        turn.items.set(item.id, existing && "streaming" in existing && method === "item/started" ? existing : body);
        if (method === "item/started" && (body.kind === "command" || body.kind === "tool_call")) {
          const summary = body.kind === "command" ? `Running ${body.command.slice(0, 60)}` : body.title;
          setLastActivity(turn.request.sessionId, { tool: item.type, summary });
          turn.request.ctx.send({ type: "agent_activity", sessionId: turn.request.sessionId, tool: item.type, summary });
        }
        break;
      }
      case "item/agentMessage/delta":
        turn.items.appendText(itemId, "assistant_text", str(params.delta));
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        turn.items.appendText(itemId, "reasoning", str(params.delta));
        break;
      case "item/commandExecution/outputDelta": {
        const current = turn.items.get(itemId);
        if (current?.kind === "command") turn.items.set(itemId, { ...current, output: clipOutput(current.output + str(params.delta)) });
        break;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? (params.plan as Array<{ step: string; status: string }>) : [];
        turn.items.set("plan", {
          kind: "todo_list",
          todos: plan.map((step) => ({ text: step.step, status: PLAN_STATUS[step.status] ?? "pending" })),
        });
        break;
      }
      case "error": {
        const error = params.error as { message?: string } | undefined;
        if (!params.willRetry) turn.items.set(`error:${Date.now()}`, { kind: "error", message: error?.message ?? "Codex error" });
        break;
      }
      case "turn/completed": {
        const completed = params.turn as { id: string; status: string; error?: { message?: string } | null };
        if (turn.codexTurnId && completed.id !== turn.codexTurnId) break;
        if (completed.status === "interrupted" || turn.interrupted) this.finish(new TurnInterruptedError());
        else if (completed.status === "failed") this.finish(new Error(completed.error?.message ?? "Codex turn failed"));
        else this.finish(turn.finalText);
        break;
      }
      default:
        break;
    }
  }

  private async handleServerRequest(request: CodexServerRequest) {
    const { id, method, params } = request;
    const approval = this.describeApproval(method, params);
    if (!approval || !this.turn) {
      // Questions the timeline cannot answer (free-form input, permission profiles) are declined.
      this.rpc.respond(id, method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "decline" });
      return;
    }
    const decision = await this.askUser(String(id), approval.title, approval.detail, codexApprovalSummary(approval.title, params.command));
    this.rpc.respond(id, approval.respond(decision));
  }

  private describeApproval(method: string, params: Params) {
    const commandDecision = (d: ApprovalDecision | "expired") => ({ decision: COMMAND_DECISION[d] });
    switch (method) {
      case "item/commandExecution/requestApproval":
        return { title: "Run command", detail: str(params.command) || str(params.reason), respond: commandDecision };
      case "item/fileChange/requestApproval":
        return { title: "Change files", detail: str(params.reason) || str(params.grantRoot) || "Apply the proposed edit", respond: commandDecision };
      case "mcpServer/elicitation/request":
        return {
          title: `Allow ${str(params.serverName)}`,
          detail: str(params.message),
          respond: (d: ApprovalDecision | "expired") =>
            d === "accept" || d === "accept-session" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null },
        };
      case "execCommandApproval":
      case "applyPatchApproval":
        return {
          title: method === "execCommandApproval" ? "Run command" : "Change files",
          detail: Array.isArray(params.command) ? (params.command as string[]).join(" ") : str(params.reason),
          respond: (d: ApprovalDecision | "expired") => ({ decision: LEGACY_DECISION[d] }),
        };
      default:
        return null;
    }
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

  private async askUser(requestId: string, title: string, detail: string, summary: string): Promise<ApprovalDecision | "expired"> {
    const turn = this.turn!;
    const itemId = `approval:${requestId}`;
    turn.items.set(itemId, { kind: "approval", requestId, title, detail, state: "pending" }, { immediate: true });
    const decision = await waitForApproval(turn.request, requestId, summary, (resolve) => this.approvals.set(requestId, resolve));
    this.approvals.delete(requestId);
    turn.items.patch(itemId, "approval", { state: decision }, { immediate: true });
    return decision;
  }
}

function getCodexThreadId(conversationId: string): string | null {
  return db.select({ id: conversations.codexSessionId }).from(conversations).where(eq(conversations.id, conversationId)).get()?.id ?? null;
}

function setCodexThreadId(conversationId: string, threadId: string) {
  db.update(conversations).set({ codexSessionId: threadId }).where(eq(conversations.id, conversationId)).run();
}
