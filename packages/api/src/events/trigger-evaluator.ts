/**
 * Event Trigger Evaluator — listens on event bus, evaluates all enabled triggers per event,
 * fires actions (notify, run-schedule, delegate) respecting cooldowns.
 */
import { on } from "./bus.js";
import { db } from "../db/index.js";
import { eventTriggers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { notify } from "../notifications/router.js";
import type { ChompEvent } from "@chomp/shared";
import type { TurnNotice } from "../agents/turn-notice.js";
import { evaluateConditions, type FieldCondition } from "../lib/event-conditions.js";

interface TriggerAction {
  type: "notify" | "run-schedule" | "delegate";
  title?: string;
  body?: string;
  scheduleId?: string;
  /** A soul or provider by name, as older triggers saved it. */
  agentName?: string;
  provider?: string;
  soulId?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  /** Send the agent's answer to the user's channels. Otherwise it stays in the trigger's conversation. */
  deliver?: boolean;
}

/** Check if trigger is within cooldown */
function isInCooldown(trigger: typeof eventTriggers.$inferSelect): boolean {
  if (trigger.cooldownSeconds <= 0 || !trigger.lastTriggeredAt) return false;
  const lastTriggered = new Date(trigger.lastTriggeredAt).getTime();
  const cooldownMs = trigger.cooldownSeconds * 1000;
  return Date.now() - lastTriggered < cooldownMs;
}

/** Execute a trigger's action */
async function executeAction(action: TriggerAction, event: ChompEvent, triggerName: string): Promise<void> {
  switch (action.type) {
    case "notify": {
      const title = action.title ?? `Trigger: ${event.type}`;
      const body = action.body ?? JSON.stringify(event);
      await notify({ type: "system", title, body });
      break;
    }
    case "run-schedule": {
      if (action.scheduleId) {
        const { schedules } = await import("../db/schema.js");
        // Reset lastRun so heartbeat picks it up
        db.update(schedules).set({
          lastRun: null,
          updatedAt: new Date().toISOString(),
        }).where(eq(schedules.id, action.scheduleId)).run();
      }
      break;
    }
    case "delegate": {
      {
        const { dispatchToAgent } = await import("../agents/dispatch.js");
        const { runTargetFrom } = await import("../agents/run-target.js");
        const { sendTurnNotice } = await import("../agents/turn-notice.js");
        const { randomUUID } = await import("crypto");
        const { conversations } = await import("../db/schema.js");
        const prompt = action.prompt ?? `Triggered by event: ${JSON.stringify(event)}`;

        // Create a conversation for the triggered agent run
        const convId = randomUUID();
        const now = new Date().toISOString();
        db.insert(conversations).values({ id: convId, title: `Trigger: ${event.type}`, createdAt: now, updatedAt: now }).run();

        const noopCtx = {
          conversationId: convId,
          send: () => {}, // No active user — output is discarded
        };
        const notice: TurnNotice | undefined = action.deliver
          ? { type: "agent-complete", title: triggerName, conversationId: convId, since: now }
          : undefined;
        try {
          const result = await dispatchToAgent(
            { action: "delegate", agent: action.agentName, prompt, reason: "event trigger" },
            noopCtx,
            { ...runTargetFrom({ ...action }), ...(notice && { deliveryChannel: "proactive", notifyWhenDone: notice }) },
          );
          if (notice) await sendTurnNotice(notice, result.response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[trigger-evaluator] Delegate failed:`, message);
          if (action.deliver) await notify({ type: "system", title: triggerName, body: `The agent failed: ${message}` });
        }
      }
      break;
    }
  }
}

/** Process a single event against all enabled triggers */
async function evaluateEvent(event: ChompEvent): Promise<void> {
  const triggers = db.select().from(eventTriggers).all()
    .filter((t) => t.enabled && t.eventType === event.type);

  for (const trigger of triggers) {
    try {
      if (isInCooldown(trigger)) continue;

      const conditions: FieldCondition[] = JSON.parse(trigger.condition);
      if (!Array.isArray(conditions)) continue;

      if (!evaluateConditions(event as unknown as Record<string, unknown>, conditions)) continue;

      const action: TriggerAction = JSON.parse(trigger.action);

      // Claim a one-shot before acting: an agent run takes minutes, and a second event must not fire it again.
      if (trigger.once && db.delete(eventTriggers).where(eq(eventTriggers.id, trigger.id)).run().changes === 0) continue;

      await executeAction(action, event, trigger.name);

      // Update lastTriggeredAt
      db.update(eventTriggers).set({
        lastTriggeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).where(eq(eventTriggers.id, trigger.id)).run();

      console.log(`[trigger-evaluator] Fired: "${trigger.name}" on ${event.type}`);
    } catch (err) {
      console.error(`[trigger-evaluator] Error evaluating "${trigger.name}":`, err instanceof Error ? err.message : err);
    }
  }
}

/** Start the trigger evaluator — subscribes to the event bus */
export function startTriggerEvaluator(): void {
  on((event) => {
    evaluateEvent(event).catch((err) =>
      console.error("[trigger-evaluator] Unhandled error:", err),
    );
  });
  console.log("[trigger-evaluator] Started");
}
