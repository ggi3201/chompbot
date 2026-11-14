import { describe, expect, test, vi } from "vitest";
import type { TurnRequest } from "../../src/agents/runtime/types.js";

/** A session that, like the real ones, refuses a second turn while one runs. */
function fakeRuntime() {
  let busy = false;
  return {
    provider: "claude" as const,
    lastUsedAt: Date.now(),
    failed: null,
    get busy() {
      return busy;
    },
    async runTurn(request: TurnRequest) {
      if (busy) throw new Error("A turn is already running in this conversation");
      busy = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      busy = false;
      return `answered: ${request.prompt}`;
    },
    steer: async () => false,
    hurry: async () => false,
    interrupt: async () => {},
    answerApproval: () => false,
    close: () => {},
  };
}

vi.mock("../../src/agents/runtime/claude.js", () => {
  const runtime = fakeRuntime();
  return { ClaudeRuntime: { start: () => runtime }, forgetClaudeSession: () => {} };
});
vi.mock("../../src/agents/runtime/codex.js", () => ({ CodexRuntime: { start: () => fakeRuntime() } }));

const { runAgentTurn } = await import("../../src/agents/runtime/pool.js");

function request(prompt: string): TurnRequest {
  return { sessionId: prompt, conversationId: "conv-1", agentName: "Claude Code", prompt, access: "full", cwd: "/tmp", ctx: { conversationId: "conv-1", send: () => {} } };
}

describe("runAgentTurn", () => {
  test("a second message while a turn runs waits for it instead of failing", async () => {
    const results = await Promise.all([runAgentTurn("claude", request("first")), runAgentTurn("claude", request("second"))]);
    expect(results).toEqual(["answered: first", "answered: second"]);
  });
});
