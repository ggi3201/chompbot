import { eq, isNotNull } from "drizzle-orm";
import type { RoutingDecision } from "@chomp/shared";
import { db } from "../../db/index.js";
import { conversations } from "../../db/schema.js";
import { dispatchToAgent } from "../dispatch.js";
import { deliverAgentResult, type ChatOptions } from "../../chat/handler.js";
import { backgroundContext } from "../../chat/websocket.js";
import { notify } from "../../notifications/router.js";
import { sendTurnNotice } from "../turn-notice.js";
import { isShuttingDown, type ResumableTurn } from "./pool.js";

const CONTINUE_PROMPT =
  "Chomp restarted while you were working on this, which also stopped any background subagents you had running. Continue from where you stopped and finish the task, relaunching the subagents that did not finish. Do not redo work that is already done.";

/**
 * Run each turn the last shutdown interrupted once more, on its own native
 * session, so it finishes instead of ending in "something interrupted". The
 * marker is cleared before the turn starts: a turn that crashes the API again
 * is not retried forever.
 */
export async function resumeInterruptedTurns() {
  const rows = db.select({ id: conversations.id, resumeTurn: conversations.resumeTurn }).from(conversations).where(isNotNull(conversations.resumeTurn)).all();
  if (rows.length === 0) return;
  console.log(`[resume] Resuming ${rows.length} turn(s) interrupted by the restart`);

  await Promise.all(rows.map(async (row) => {
    db.update(conversations).set({ resumeTurn: null }).where(eq(conversations.id, row.id)).run();
    let turn: ResumableTurn;
    try {
      turn = JSON.parse(row.resumeTurn!) as ResumableTurn;
    } catch {
      return;
    }
    const ctx = backgroundContext(row.id);
    const options = turn.options as ChatOptions;
    const routing: RoutingDecision = { action: "delegate", agent: turn.agent, prompt: CONTINUE_PROMPT, reason: "resume-after-restart" };
    try {
      const result = await dispatchToAgent(routing, ctx, options);
      deliverAgentResult(row.id, routing, result, ctx);
      if (options.notifyWhenDone) await sendTurnNotice(options.notifyWhenDone, result.response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Resume failed";
      console.error(`[resume] Conversation ${row.id.slice(0, 8)} could not resume:`, message);
      ctx.send({ type: "error", error: message, recovered: true });
      // Another restart saves the turn again, so only a real failure ends the wait for its message.
      if (options.notifyWhenDone && !isShuttingDown()) {
        const { since: _since, ...delivery } = options.notifyWhenDone;
        await notify({ ...delivery, body: `A restart interrupted this run and it could not finish: ${message}`, broadcast: true }).catch(() => {});
      }
    }
  }));
}
