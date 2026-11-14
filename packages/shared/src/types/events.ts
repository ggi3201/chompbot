/** Discriminated union of all Chomp system events */
export type ChompEvent =
  | { type: "chat.message"; conversationId: string; role: string; content: string; agentUsed?: string }
  | { type: "agent.started"; sessionId: string; agentName: string; agentType: string; conversationId?: string }
  | { type: "agent.completed"; sessionId: string; agentName: string; durationMs: number }
  | { type: "agent.failed"; sessionId: string; agentName: string; error: string }
  | { type: "schedule.completed"; scheduleId: string; scheduleName: string; result: string }
  | { type: "schedule.failed"; scheduleId: string; scheduleName: string; error: string }
  | { type: "service.health.changed"; serviceId: string; serviceName: string; oldStatus: string; newStatus: string }
  | { type: "user.active"; channel: "web" | "telegram" }
  | { type: "user.idle"; channel?: "web" | "telegram" }
  | { type: "memory.saved"; memoryId: string; category: string; content: string; source: string }
  | { type: "webhook.received"; webhookId: string; webhookName: string; payload: unknown; headers?: Record<string, string> }
  | { type: "location.changed"; transition: "arrive" | "leave"; place: string; source: string; latitude: number; longitude: number; capturedAt: string }
  | { type: "monitoring.incident.opened"; incidentId: string; title: string; causeKey: string; targetKeys: string[] }
  | { type: "monitoring.incident.resolved"; incidentId: string; title: string; durationMs: number }
  | { type: "monitoring.warning.new"; key: string; kind: string; targetKey: string | null; text: string }
  | { type: "system.startup" };
