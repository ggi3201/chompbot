import type { RoutingDecision } from "@chomp/shared";
import { deliverAgentResult } from "../../chat/handler.js";
import { getSessionReply, hasSessionReplied } from "../../mcp/state.js";
import { TurnInterruptedError, type TurnRequest } from "./types.js";

/**
 * Deliver a turn Claude Code started on its own, after a background task
 * finished, to the chat of the turn before it: same persistence and `done`
 * event as a turn the user started.
 */
export async function deliverWakeTurn(request: TurnRequest, done: Promise<string>) {
  const { conversationId, ctx } = request;
  const routing: RoutingDecision = { action: "delegate", agent: request.agentName, reason: "background-task-finished" };
  try {
    const response = await done;
    deliverAgentResult(
      conversationId,
      routing,
      {
        response,
        agentUsed: request.agentName,
        alreadySent: !response.trim() && hasSessionReplied(request.sessionId),
        replyMessage: getSessionReply(request.sessionId),
        turnId: request.sessionId,
      },
      ctx,
    );
  } catch (err) {
    if (err instanceof TurnInterruptedError) return;
    ctx.send({ type: "error", error: err instanceof Error ? err.message : "Background turn failed", recovered: true });
  }
}
