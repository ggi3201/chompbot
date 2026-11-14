import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversations } from "../../src/db/schema.js";
import type { TurnRequest } from "../../src/agents/runtime/types.js";

interface FakeSession {
  busy: boolean;
  hasLiveAgents: boolean;
  lastUsedAt: number;
  close: ReturnType<typeof vi.fn>;
}

const sessions = vi.hoisted(() => new Map<string, FakeSession>());

vi.mock("../../src/agents/runtime/claude.js", () => ({
  ClaudeRuntime: {
    start(conversationId: string) {
      const session = {
        provider: "claude" as const,
        failed: null,
        busy: false,
        hasLiveAgents: false,
        lastUsedAt: Date.now(),
        close: vi.fn(),
        runTurn: async () => "answered",
        steer: async () => false,
        hurry: async () => false,
        interrupt: async () => {},
        answerApproval: () => false,
      };
      sessions.set(conversationId, session);
      return session;
    },
  },
  forgetClaudeSession: () => {},
}));
vi.mock("../../src/agents/runtime/codex.js", () => ({ CodexRuntime: { start: () => { throw new Error("not in this test"); } } }));

const NOW = "2026-11-04T12:00:00.000Z";
const MINUTE = 60_000;

function request(conversationId: string): TurnRequest {
  return { sessionId: `turn-${conversationId}`, conversationId, agentName: "Claude Code", prompt: "go", access: "full", cwd: "/tmp", ctx: { conversationId, send: () => {} } };
}

let pool: typeof import("../../src/agents/runtime/pool.js");

/** A conversation whose only turn has ended, the way the dispatcher leaves it. */
async function idleConversation(id: string, options: Record<string, unknown> = { provider: "claude" }): Promise<FakeSession> {
  db.insert(conversations).values({ id, createdAt: NOW, updatedAt: NOW }).onConflictDoNothing().run();
  pool.trackRunningTurn(id, { agent: "Alfred", options });
  await pool.runAgentTurn("claude", request(id));
  pool.trackRunningTurn(id, null);
  return sessions.get(id)!;
}

function marker(id: string) {
  const saved = db.select({ resumeTurn: conversations.resumeTurn }).from(conversations).where(eq(conversations.id, id)).get()?.resumeTurn;
  return saved ? JSON.parse(saved) : null;
}

beforeAll(async () => {
  // Before the import: the sweep's interval starts when the pool loads.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  pool = await import("../../src/agents/runtime/pool.js");
});

beforeEach(() => {
  db.update(conversations).set({ resumeTurn: null }).run();
});

describe("the idle sweep", () => {
  test("closes a session with nothing running", async () => {
    const session = await idleConversation("sweep-idle");
    vi.advanceTimersByTime(31 * MINUTE);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("spares a session whose subagent still runs, and closes it once that ends", async () => {
    const session = await idleConversation("sweep-agent");
    session.hasLiveAgents = true;
    vi.advanceTimersByTime(31 * MINUTE);
    expect(session.close).not.toHaveBeenCalled();

    session.hasLiveAgents = false;
    vi.advanceTimersByTime(MINUTE);
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

// Last: a shutdown closes every session and flags the pool as shutting down.
describe("a shutdown", () => {
  test("saves idle sessions with live subagents, a running turn as before, and leaves plain idle ones", async () => {
    const notice = { type: "agent-complete", title: "Daily", conversationId: "x", since: NOW, channels: ["telegram"] };

    const agents = await idleConversation("down-agents", { provider: "claude", notifyWhenDone: notice });
    agents.hasLiveAgents = true;
    const idle = await idleConversation("down-idle");
    const running = await idleConversation("down-running");
    pool.trackRunningTurn("down-running", { agent: "Alfred", options: { provider: "claude", notifyWhenDone: notice } });
    running.busy = true;
    // A turn the session started itself never went through the dispatcher.
    const wake = await idleConversation("down-wake");
    wake.busy = true;

    expect(pool.suspendForShutdown()).toBe(3);

    // Its turn already ended and sent its notice; waking for the agents must not send it twice.
    expect(marker("down-agents")).toEqual({ agent: "Alfred", options: { provider: "claude" } });
    expect(marker("down-running")).toEqual({ agent: "Alfred", options: { provider: "claude", notifyWhenDone: notice } });
    expect(marker("down-wake")).toEqual({ agent: "Alfred", options: { provider: "claude" } });
    expect(marker("down-idle")).toBeNull();
    for (const session of [agents, idle, running, wake]) expect(session.close).toHaveBeenCalledTimes(1);
  });
});
