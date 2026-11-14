/**
 * Activity Logger — subscribes to the event bus and persists relevant events
 * to the activity_log table so they appear in the Activity page.
 */
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import { activityLog } from "../db/schema.js";
import { on } from "./bus.js";
import type { ChompEvent } from "@chomp/shared";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function buildEntry(event: ChompEvent): {
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  scheduleId?: string;
  agentUsed?: string;
} | null {
  switch (event.type) {
    case "agent.started":
      return {
        type: event.type,
        summary: `Agent "${event.agentName}" started`,
        agentUsed: event.agentName,
        details: { sessionId: event.sessionId, agentType: event.agentType },
      };

    case "agent.completed":
      return {
        type: event.type,
        summary: `Agent "${event.agentName}" completed in ${Math.round(event.durationMs / 1000)}s`,
        agentUsed: event.agentName,
        details: { sessionId: event.sessionId, durationMs: event.durationMs },
      };

    case "agent.failed":
      return {
        type: event.type,
        summary: `Agent "${event.agentName}" failed: ${truncate(event.error, 120)}`,
        agentUsed: event.agentName,
        details: { sessionId: event.sessionId, error: event.error },
      };

    case "chat.message": {
      const preview = truncate(event.content, 120);
      return {
        type: event.type,
        summary: `${event.role === "user" ? "User" : "Assistant"}: ${preview}`,
        agentUsed: event.agentUsed ?? undefined,
        details: { role: event.role, conversationId: event.conversationId },
      };
    }

    case "webhook.received":
      return {
        type: event.type,
        summary: `Webhook "${event.webhookName}" received`,
        details: {
          webhookId: event.webhookId,
          payload: typeof event.payload === "object" && event.payload !== null
            ? Object.keys(event.payload as object).slice(0, 5).join(", ")
            : String(event.payload).slice(0, 100),
        },
      };

    case "location.changed":
      return {
        type: event.type,
        summary: `${event.transition === "arrive" ? "Arrived at" : "Left"} ${event.place}`,
        details: { source: event.source, capturedAt: event.capturedAt },
      };

    case "memory.saved":
      return {
        type: event.type,
        summary: `Memory saved [${event.category}]: ${truncate(event.content, 100)}`,
        details: { memoryId: event.memoryId, source: event.source, category: event.category },
      };

    case "schedule.completed":
      return {
        type: event.type,
        summary: `Schedule "${event.scheduleName}" completed`,
        scheduleId: event.scheduleId,
        details: { result: truncate(event.result, 200) },
      };

    case "schedule.failed":
      return {
        type: event.type,
        summary: `Schedule "${event.scheduleName}" failed: ${truncate(event.error, 120)}`,
        scheduleId: event.scheduleId,
        details: { error: event.error },
      };

    case "service.health.changed":
      return {
        type: event.type,
        summary: `${event.serviceName} health: ${event.oldStatus} → ${event.newStatus}`,
        details: { serviceId: event.serviceId, oldStatus: event.oldStatus, newStatus: event.newStatus },
      };

    case "system.startup":
      return {
        type: event.type,
        summary: "System started",
      };

    // Skip noisy presence events
    case "user.active":
    case "user.idle":
      return null;

    default:
      return null;
  }
}

/** Start the activity logger — subscribes to the event bus and writes to activity_log */
export function startActivityLogger(): void {
  on((event) => {
    try {
      const entry = buildEntry(event);
      if (!entry) return;

      db.insert(activityLog).values({
        id: randomUUID(),
        type: entry.type,
        summary: entry.summary,
        details: entry.details ? JSON.stringify(entry.details) : null,
        scheduleId: entry.scheduleId ?? null,
        agentUsed: entry.agentUsed ?? null,
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      console.error("[activity-logger] Failed to log activity:", err instanceof Error ? err.message : err);
    }
  });
  console.log("[activity-logger] Started");
}
