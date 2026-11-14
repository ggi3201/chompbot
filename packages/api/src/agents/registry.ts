/**
 * Agent Session Registry — centralized tracking of all active agent sessions
 * with guardrails (concurrent limits, output caps, idle timeout, circuit breaker).
 */

import { db } from "../db/index.js";
import { agentSessions, settings } from "../db/schema.js";
import { and, desc, like, eq, or, count as countFn } from "drizzle-orm";

export interface AgentSession {
  sessionId: string;
  ccSessionId?: string;
  agentName: string;
  agentType: string;
  conversationId?: string;
  pid?: number;
  prompt?: string;
  userPrompt?: string;
  label?: string;
  model?: string;
  error?: string;
  logPath?: string;
  startedAt: number;
  lastOutputAt: number;
  outputBytes: number;
  outputChunks: number;
  status: "running" | "completed" | "failed" | "killed" | "timed_out" | "crashed";
  lastActivity?: { tool: string; summary: string };
}

// ── Configuration (defaults, overridable via settings table) ────

export const GUARDRAIL_DEFAULTS = {
  max_concurrent_agents: 2,
  max_output_bytes: 2 * 1024 * 1024, // 2MB
  agent_idle_timeout_ms: 45 * 60 * 1000, // 45 minutes
  circuit_breaker_window_ms: 30 * 60 * 1000, // 30 minutes
  circuit_breaker_failures: 3,
  circuit_breaker_cooldown_ms: 30 * 60 * 1000, // 30 minutes
  max_dispatches_per_hour: 10,
} as const;

export type GuardrailKey = keyof typeof GUARDRAIL_DEFAULTS;

/** Read a numeric guardrail from the settings table, falling back to the compiled default. */
export function getGuardrail(key: GuardrailKey): number {
  try {
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    if (row) {
      const parsed = Number(row.value);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // DB not ready yet (e.g. during startup) — fall back silently
  }
  return GUARDRAIL_DEFAULTS[key];
}

// ── State ───────────────────────────────────────────────────────

const activeSessions = new Map<string, AgentSession>();
const sessionHistory: AgentSession[] = [];
const MAX_HISTORY = 50;

// Circuit breaker: agent name → array of failure timestamps
const failureLog = new Map<string, number[]>();
// Circuit breaker: agent name → cooldown-until timestamp
const circuitBrokenUntil = new Map<string, number>();

// Kill callbacks: sessionId → function that kills the process
const killCallbacks = new Map<string, () => void>();

// ── Public API ──────────────────────────────────────────────────

export function registerSession(session: Omit<AgentSession, "status" | "lastOutputAt" | "outputBytes" | "outputChunks" | "error">): AgentSession {
  const full: AgentSession = {
    ...session,
    lastOutputAt: session.startedAt,
    outputBytes: 0,
    outputChunks: 0,
    status: "running",
  };
  activeSessions.set(session.sessionId, full);
  console.log(`[registry] Session started: ${session.agentName} (${session.sessionId.slice(0, 8)})`);
  return full;
}

/**
 * Persist a running session to the DB immediately after spawn.
 * This allows the session to survive API restarts — on startup we query
 * the DB for rows with status="running" and reconnect to alive PIDs.
 */
export function persistRunningSession(sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  try {
    db.insert(agentSessions).values({
      sessionId: session.sessionId,
      ccSessionId: session.ccSessionId ?? null,
      agentName: session.agentName,
      agentType: session.agentType,
      conversationId: session.conversationId ?? null,
      pid: session.pid ?? null,
      prompt: session.prompt ?? null,
      userPrompt: session.userPrompt ?? null,
      label: session.label ?? null,
      model: session.model ?? null,
      logPath: session.logPath ?? null,
      status: "running",
      outputBytes: 0,
      outputChunks: 0,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: null,
    }).run();
  } catch (err) {
    console.error("[registry] Failed to persist running session:", err);
  }
}

/** Check if a process is still alive by sending signal 0. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerKillCallback(sessionId: string, kill: () => void) {
  killCallbacks.set(sessionId, kill);
}

/** Touch session to reset idle timer (e.g. from progress heartbeats) */
export function touchSession(sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (session) session.lastOutputAt = Date.now();
}

export function updateOutput(sessionId: string, bytes: number): "ok" | "output_cap_exceeded" {
  const session = activeSessions.get(sessionId);
  if (!session) return "ok";

  session.outputBytes += bytes;
  session.outputChunks += 1;
  session.lastOutputAt = Date.now();

  // Check output cap
  if (session.outputBytes > getGuardrail("max_output_bytes")) {
    console.warn(`[registry] Output cap exceeded for ${session.agentName}: ${session.outputBytes} bytes`);
    killSession(sessionId, "killed");
    return "output_cap_exceeded";
  }

  return "ok";
}

export function completeSession(sessionId: string, status: AgentSession["status"] = "completed", error?: string) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  session.status = status;
  if (error) session.error = error;
  activeSessions.delete(sessionId);
  killCallbacks.delete(sessionId);

  // Track in history
  sessionHistory.unshift(session);
  if (sessionHistory.length > MAX_HISTORY) sessionHistory.pop();

  // Persist to DB — update existing row if it was persisted on spawn, else insert
  try {
    const existing = db.select().from(agentSessions).where(eq(agentSessions.sessionId, session.sessionId)).get();
    if (existing) {
      db.update(agentSessions).set({
        status,
        outputBytes: session.outputBytes,
        outputChunks: session.outputChunks,
        durationMs: Math.round(session.lastOutputAt - session.startedAt),
        error: session.error ?? null,
        endedAt: new Date().toISOString(),
      }).where(eq(agentSessions.sessionId, session.sessionId)).run();
    } else {
      db.insert(agentSessions).values({
        sessionId: session.sessionId,
        ccSessionId: session.ccSessionId ?? null,
        agentName: session.agentName,
        agentType: session.agentType,
        conversationId: session.conversationId ?? null,
        pid: session.pid ?? null,
        prompt: session.prompt ?? null,
        userPrompt: session.userPrompt ?? null,
        label: session.label ?? null,
        model: session.model ?? null,
        logPath: session.logPath ?? null,
        status,
        outputBytes: session.outputBytes,
        outputChunks: session.outputChunks,
        durationMs: Math.round(session.lastOutputAt - session.startedAt),
        error: session.error ?? null,
        startedAt: new Date(session.startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      }).run();
    }
  } catch (err) {
    console.error("[registry] Failed to persist session:", err);
  }

  // Track failures for circuit breaker
  if (status === "failed" || status === "timed_out") {
    const failures = failureLog.get(session.agentName) ?? [];
    failures.push(Date.now());
    failureLog.set(session.agentName, failures);

    // Check circuit breaker
    const windowMs = getGuardrail("circuit_breaker_window_ms");
    const recentFailures = failures.filter((t) => Date.now() - t < windowMs);
    failureLog.set(session.agentName, recentFailures);

    if (recentFailures.length >= getGuardrail("circuit_breaker_failures")) {
      const until = Date.now() + getGuardrail("circuit_breaker_cooldown_ms");
      circuitBrokenUntil.set(session.agentName, until);
      console.warn(`[registry] Circuit breaker tripped for ${session.agentName} until ${new Date(until).toISOString()}`);
    }
  }

  const duration = ((Date.now() - session.startedAt) / 1000).toFixed(1);
  console.log(`[registry] Session ${status}: ${session.agentName} (${duration}s, ${session.outputBytes} bytes)`);
}

export function killSession(sessionId: string, status: AgentSession["status"] = "killed"): boolean {
  const kill = killCallbacks.get(sessionId);
  if (kill) {
    kill();
    completeSession(sessionId, status);
    return true;
  }
  return false;
}

export function killAllSessions(): number {
  let killed = 0;
  for (const sessionId of activeSessions.keys()) {
    if (killSession(sessionId)) killed++;
  }
  return killed;
}

export function setLastActivity(sessionId: string, activity: { tool: string; summary: string }) {
  const session = activeSessions.get(sessionId);
  if (session) session.lastActivity = activity;
}

export function getLastActivity(sessionId: string): { tool: string; summary: string } | undefined {
  return activeSessions.get(sessionId)?.lastActivity;
}

export function getActiveSessionByConversation(conversationId: string): AgentSession | undefined {
  for (const session of activeSessions.values()) {
    if (session.conversationId === conversationId) return session;
  }
  return undefined;
}

export function getActiveSessions(): AgentSession[] {
  return Array.from(activeSessions.values());
}

export interface SessionHistoryQuery {
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
  agent?: string;
}

export interface SessionHistoryResult {
  rows: Array<typeof agentSessions.$inferSelect>;
  total: number;
}

export function getSessionHistory(opts: SessionHistoryQuery = {}): SessionHistoryResult {
  const { limit = 20, offset = 0, search, status, agent } = opts;

  const conditions = [];
  if (status) conditions.push(eq(agentSessions.status, status));
  if (agent) conditions.push(eq(agentSessions.agentName, agent));
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(or(
      like(agentSessions.prompt, pattern),
      like(agentSessions.label, pattern),
      like(agentSessions.agentName, pattern),
    )!);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db.select()
    .from(agentSessions)
    .where(where)
    .orderBy(desc(agentSessions.startedAt))
    .limit(limit)
    .offset(offset)
    .all();

  const [{ total }] = db.select({ total: countFn() })
    .from(agentSessions)
    .where(where)
    .all();

  return { rows, total };
}

// ── Guardrails ──────────────────────────────────────────────────

export interface CanDispatchResult {
  allowed: boolean;
  reason?: string;
}

export function canDispatch(agentName: string): CanDispatchResult {
  // Check concurrent limit
  const active = activeSessions.size;
  const maxConcurrent = getGuardrail("max_concurrent_agents");
  if (active >= maxConcurrent) {
    return { allowed: false, reason: `Concurrent agent limit reached (${active}/${maxConcurrent}). Wait for a running agent to finish.` };
  }

  // Check circuit breaker
  const brokenUntil = circuitBrokenUntil.get(agentName);
  if (brokenUntil && Date.now() < brokenUntil) {
    const minsLeft = Math.ceil((brokenUntil - Date.now()) / 60000);
    const cbFailures = getGuardrail("circuit_breaker_failures");
    const cbWindowMin = Math.round(getGuardrail("circuit_breaker_window_ms") / 60000);
    return { allowed: false, reason: `Agent "${agentName}" is temporarily disabled (${cbFailures} failures in ${cbWindowMin} min). Cooldown: ${minsLeft} min remaining.` };
  }

  // Clear expired circuit breaker
  if (brokenUntil && Date.now() >= brokenUntil) {
    circuitBrokenUntil.delete(agentName);
  }

  return { allowed: true };
}

// ── Idle timeout checker ────────────────────────────────────────

function checkIdleTimeouts() {
  const now = Date.now();
  const idleTimeout = getGuardrail("agent_idle_timeout_ms");
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastOutputAt > idleTimeout) {
      console.warn(`[registry] Idle timeout for ${session.agentName} (no output for ${idleTimeout / 1000}s)`);
      killSession(sessionId, "timed_out");
    }
  }
}

// Check idle timeouts every 30 seconds
setInterval(checkIdleTimeouts, 30_000);
