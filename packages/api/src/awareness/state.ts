/**
 * Awareness State — Chomp's in-memory "mental model" of the world.
 * Updated by event bus listeners. Not persisted — rebuilt on startup from DB, kept current via events.
 */
import { on } from "../events/bus.js";
import type { ChompEvent } from "@chomp/shared";

export interface UserState {
  isOnline: boolean;
  lastActiveAt: number;
  activeChannel: "web" | "telegram" | null;
}

export interface ServiceState {
  name: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  lastCheckedAt: number;
  consecutiveFailures: number;
}

export interface AwarenessState {
  user: UserState;
  services: Map<string, ServiceState>;
  recentEvents: ChompEvent[];
  activeAgentSessions: Set<string>;
  startedAt: number;
}

// ── Singleton state ─────────────────────────────────────────────

const state: AwarenessState = {
  user: {
    isOnline: false,
    lastActiveAt: 0,
    activeChannel: null,
  },
  services: new Map(),
  recentEvents: [],
  activeAgentSessions: new Set(),
  startedAt: Date.now(),
};

const MAX_RECENT_EVENTS = 50;

// ── Public API ──────────────────────────────────────────────────

export function getAwarenessState(): AwarenessState {
  return state;
}

export function getAwarenessSnapshot(): object {
  return {
    user: { ...state.user },
    services: Object.fromEntries(state.services),
    activeAgents: Array.from(state.activeAgentSessions),
    recentEventTypes: state.recentEvents.slice(-10).map((e) => e.type),
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
  };
}

/** Get a text summary for injection into triage/agent prompts */
export function getAwarenessContext(): string {
  const parts: string[] = ["## System Awareness"];

  // User presence
  if (state.user.isOnline) {
    parts.push(`- User is online via ${state.user.activeChannel}`);
  } else if (state.user.lastActiveAt > 0) {
    const agoMin = Math.round((Date.now() - state.user.lastActiveAt) / 60000);
    parts.push(`- User was last active ${agoMin} min ago`);
  } else {
    parts.push("- User has not been seen this session");
  }

  // Active agents
  if (state.activeAgentSessions.size > 0) {
    parts.push(`- ${state.activeAgentSessions.size} agent(s) currently running`);
  }

  // Service health
  const downServices = Array.from(state.services.values()).filter((s) => s.status === "down");
  const degradedServices = Array.from(state.services.values()).filter((s) => s.status === "degraded");
  if (downServices.length > 0) {
    parts.push(`- DOWN services: ${downServices.map((s) => s.name).join(", ")}`);
  }
  if (degradedServices.length > 0) {
    parts.push(`- Degraded services: ${degradedServices.map((s) => s.name).join(", ")}`);
  }

  // Uptime
  const uptimeHours = ((Date.now() - state.startedAt) / 3600000).toFixed(1);
  parts.push(`- System uptime: ${uptimeHours}h`);

  return parts.join("\n");
}

// ── Event listeners ─────────────────────────────────────────────

function initAwarenessListeners() {
  on((event) => {
    // Track all events in ring buffer
    state.recentEvents.push(event);
    if (state.recentEvents.length > MAX_RECENT_EVENTS) {
      state.recentEvents.shift();
    }

    switch (event.type) {
      case "user.active":
        state.user.isOnline = true;
        state.user.lastActiveAt = Date.now();
        state.user.activeChannel = event.channel;
        break;

      case "user.idle":
        state.user.isOnline = false;
        break;

      case "agent.started":
        state.activeAgentSessions.add(event.sessionId);
        break;

      case "agent.completed":
      case "agent.failed":
        state.activeAgentSessions.delete(event.sessionId);
        break;

      case "service.health.changed":
        state.services.set(event.serviceId, {
          name: event.serviceName,
          status: event.newStatus as ServiceState["status"],
          lastCheckedAt: Date.now(),
          consecutiveFailures: event.newStatus === "down" ? (state.services.get(event.serviceId)?.consecutiveFailures ?? 0) + 1 : 0,
        });
        break;
    }
  });
}

// Auto-initialize on import
initAwarenessListeners();
