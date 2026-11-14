import type { AccessMode, AgentProvider, ApprovalDecision, ContextUsage } from "@chomp/shared";
import type { ApprovalOutcome, ApprovalQuestion } from "./approval.js";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { agentSessions } from "../../db/schema.js";
import type { DeliveryChannel } from "../../channels/response-format.js";
import type { ChatContext } from "../../chat/handler.js";

export interface TurnRequest {
  /** Dispatch session id — the turn id items and messages are tagged with. */
  sessionId: string;
  conversationId: string;
  agentName: string;
  /** What the agent sees as the user message this turn. */
  prompt: string;
  /** The user's own words, for the session registry. */
  userPrompt?: string;
  /** Soul, skills, memories… Applied only when a native session starts fresh. */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  access: AccessMode;
  deliveryChannel?: DeliveryChannel;
  /** Claude only: keep the Claude.ai login (default) or allow Console API keys. */
  claudeAuthMode?: "subscription" | "api-key";
  cwd: string;
  label?: string;
  ctx: ChatContext;
}

/**
 * One live CLI session bound to one Chomp conversation. The process outlives
 * the turn so the next message, a steer or an approval reaches the same
 * native session without a cold start.
 */
export interface AgentRuntime {
  readonly provider: AgentProvider;
  /** True while a turn is running. */
  readonly busy: boolean;
  readonly lastUsedAt: number;
  /** True while a subagent runs past the turn that started it. Closing the session would kill it. */
  readonly hasLiveAgents?: boolean;
  /** Runs one turn and resolves with the agent's final text. */
  runTurn(request: TurnRequest): Promise<string>;
  /** Adds the user's text to the running turn. False when nothing is running. */
  steer(text: string): Promise<boolean>;
  interrupt(): Promise<void>;
  /** Stops the current step so waiting steers run now, keeping the turn. False when nothing waits. */
  hurry(): Promise<boolean>;
  answerApproval(requestId: string, decision: ApprovalDecision): boolean;
  /** Ask the user from inside the running turn. Ends in "expired" if that turn is gone by the answer. */
  requestApproval(question: ApprovalQuestion): Promise<ApprovalOutcome>;
  /** A fresh read of the session's context, where the CLI can answer between turns. */
  contextUsage?(): Promise<ContextUsage | null>;
  close(): void;
}

export class TurnInterruptedError extends Error {
  constructor() {
    super("Turn interrupted");
  }
}

/** Registry status for how a turn ended. */
export function turnSessionStatus(outcome: string | Error): "completed" | "failed" | "killed" {
  if (!(outcome instanceof Error)) return "completed";
  return outcome instanceof TurnInterruptedError ? "killed" : "failed";
}

/** Where a fork of this turn can start, recorded once the turn has finished. */
export function recordForkPoint(sessionId: string, nativeRef: string | null, cwd: string) {
  if (!nativeRef) return;
  db.update(agentSessions).set({ nativeRef, cwd }).where(eq(agentSessions.sessionId, sessionId)).run();
}
