import { describe, expect, test } from "vitest";
import { placeholderTitle, shouldForwardAgentResponse, steeredMessage } from "../../src/chat/handler.js";
import type { SessionReply } from "../../src/mcp/state.js";

function reply(content: string): SessionReply {
  return {
    id: "reply-1",
    content,
    agentUsed: "Codex",
    createdAt: "2026-05-28T10:00:00.000Z",
  };
}

describe("shouldForwardAgentResponse", () => {
  test("does not forward empty runner text", () => {
    expect(shouldForwardAgentResponse("")).toBe(false);
    expect(shouldForwardAgentResponse("  \n  ")).toBe(false);
    expect(shouldForwardAgentResponse(undefined)).toBe(false);
  });

  test("suppresses duplicate text already sent by chomp_reply", () => {
    expect(shouldForwardAgentResponse("Final answer", reply("Final answer"))).toBe(false);
    expect(shouldForwardAgentResponse("  Final answer\n", reply("Final answer"))).toBe(false);
  });

  test("forwards final runner text when only a progress reply was sent", () => {
    expect(shouldForwardAgentResponse("Final answer", reply("Reading the files..."))).toBe(true);
  });

  test("suppresses runner text after a reply for CLI-only reply agents", () => {
    expect(shouldForwardAgentResponse(
      "I am checking the source...",
      reply("Done — source updated."),
      { suppressRunnerResponseAfterReply: true },
    )).toBe(false);
  });
});

describe("placeholderTitle", () => {
  test("names a handoff chat by the note's goal, not its heading", () => {
    const note = "# Handoff\n\n**Goal:** Tell the user their code word and their number when asked.\n\n**State:**\n- Code word: BANANA";
    expect(placeholderTitle(note)).toBe("Tell the user their code word and their number when asked.");
  });

  test("keeps any other first message as it was", () => {
    expect(placeholderTitle("fix the `npm_test` script\nplease")).toBe("fix the `npm_test` script please");
  });
});

describe("steeredMessage", () => {
  test("keeps an image sent into a running turn, for the chat and the agent", () => {
    const { stored, forAgent } = steeredMessage("look", [{ url: "/api/uploads/a.png", name: "a.png", mimeType: "image/png" }]);
    expect(stored).toBe("look\n\n![a.png](/api/uploads/a.png)");
    expect(forAgent).toMatch(/^look\n\n!\[a\.png\]\(\/api\/uploads\/a\.png\)\n\nAttached files, on disk:\n- a\.png \(image\/png\): \/.+a\.png$/);
  });

  test("text alone stays as is", () => {
    expect(steeredMessage("hi")).toEqual({ stored: "hi", forAgent: "hi" });
  });
});
