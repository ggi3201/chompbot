import { describe, expect, test } from "vitest";
import {
  clearSessionState,
  hasSessionEndedOnReply,
  isChompReplyTool,
  markSessionToolUse,
} from "../../src/mcp/state.js";

describe("isChompReplyTool", () => {
  test("matches the chomp reply tool under both server names, and nothing else", () => {
    expect(isChompReplyTool("mcp__chomp-api__reply")).toBe(true);
    expect(isChompReplyTool("mcp__chomp__chomp_reply")).toBe(true);
    expect(isChompReplyTool("mcp__chomp-api__ask_user")).toBe(false);
    expect(isChompReplyTool("mcp__claude_ai_Gmail__reply")).toBe(false);
    expect(isChompReplyTool("Bash")).toBe(false);
  });
});

describe("hasSessionEndedOnReply", () => {
  test("is true only when chomp_reply was the last tool call", () => {
    const id = "session-ended-on-reply";
    markSessionToolUse(id, "mcp__chomp-api__reply");
    markSessionToolUse(id, "Bash");
    expect(hasSessionEndedOnReply(id)).toBe(false);

    markSessionToolUse(id, "mcp__chomp-api__reply");
    expect(hasSessionEndedOnReply(id)).toBe(true);

    clearSessionState(id);
    expect(hasSessionEndedOnReply(id)).toBe(false);
  });
});
