import { describe, expect, it } from "vitest";
import { getResponseFormatInstruction } from "../../src/channels/response-format.js";

describe("response format instructions", () => {
  it("defaults to web-chat formatting", () => {
    const instruction = getResponseFormatInstruction();

    expect(instruction).toContain("Chomp web chat");
    expect(instruction).toContain("Canvas blocks when useful");
    expect(instruction).toContain("Do not optimize the prose for Telegram or Discord");
  });

  it("disables Canvas for notification surfaces", () => {
    expect(getResponseFormatInstruction("telegram")).toContain("Avoid Canvas blocks");
    expect(getResponseFormatInstruction("discord")).toContain("Avoid Canvas blocks");
    expect(getResponseFormatInstruction("proactive")).toContain("Canvas is disabled");
  });
});
