import { test, expect, vi } from "vitest";
import {
  deliverAgentReply,
  deliverFallbackReply,
  humanizeTurnFailure,
} from "../../src/mcp/reply-delivery.js";
import {
  hasSessionReplied,
  clearSessionState,
  replyCallbacks,
} from "../../src/mcp/state.js";

test("humanizeTurnFailure maps internal kill/timeout strings to human text", () => {
  expect(humanizeTurnFailure("Lingering PTY terminated (kill-session)")).toMatch(/stopped/i);
  expect(humanizeTurnFailure("Claude runner timed out after 600000ms")).toMatch(/timed out/i);
  expect(humanizeTurnFailure("Claude returned to the terminal prompt without sending chomp_reply"))
    .toMatch(/didn't send a final reply/i);
  // Unknown errors still produce a human message that embeds the original.
  expect(humanizeTurnFailure("boom")).toMatch(/boom/);
});

test("deliverFallbackReply delivers once when nothing landed, then guards repeats", () => {
  const sessionId = "sess-no-reply";
  clearSessionState(sessionId);
  expect(hasSessionReplied(sessionId)).toBe(false);

  const cb = vi.fn();
  replyCallbacks.push(cb);
  try {
    const first = deliverFallbackReply(sessionId, "you got interrupted");
    expect(first).not.toBeNull();
    expect(first?.content).toBe("you got interrupted");
    expect(hasSessionReplied(sessionId)).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);

    // A second fallback attempt is now suppressed by the guard.
    const second = deliverFallbackReply(sessionId, "second attempt");
    expect(second).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  } finally {
    replyCallbacks.splice(replyCallbacks.indexOf(cb), 1);
    clearSessionState(sessionId);
  }
});

test("deliverAgentReply always marks the session replied and fires callbacks", () => {
  const sessionId = "sess-direct";
  clearSessionState(sessionId);

  const cb = vi.fn();
  replyCallbacks.push(cb);
  try {
    const reply = deliverAgentReply(sessionId, "hello");
    expect(reply.content).toBe("hello");
    expect(reply.agentUsed).toBe("Chomp"); // no agentSessions row → default attribution
    expect(hasSessionReplied(sessionId)).toBe(true);
    expect(cb).toHaveBeenCalledWith(sessionId, expect.objectContaining({ content: "hello" }));
  } finally {
    replyCallbacks.splice(replyCallbacks.indexOf(cb), 1);
    clearSessionState(sessionId);
  }
});
