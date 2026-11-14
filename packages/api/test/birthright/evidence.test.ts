import { describe, expect, it } from "vitest";
import { pickCorrections, pickTrialMessages, type ChatRow } from "../../src/birthright/evidence.js";

const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`;
const user = (conversationId: string, text: string, minute = 0): ChatRow => ({ conversationId, role: "user", text, tail: "", createdAt: at(minute) });
const agent = (conversationId: string, tail: string, minute = 0): ChatRow => ({ conversationId, role: "assistant", text: tail, tail, createdAt: at(minute) });

describe("pickCorrections", () => {
  it("finds pushback and standing rules, not plain requests", () => {
    const lines = pickCorrections([
      user("a", "Can you add a dark mode to the settings page?", 1),
      user("b", "Still does not work in prod", 2),
      user("c", "From now on tag me as reviewer on every PR", 3),
      user("d", "Hvorfor kjørte ikke den i dag?", 4),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.join()).not.toContain("dark mode");
  });

  it("adds what a short reply was answering, from the same conversation only", () => {
    const [line] = pickCorrections([agent("a", "Merged and deployed."), user("a", "Still no", 1)]);
    expect(line).toBe('- "Still no" (replying to: "Merged and deployed.")');
    const [other] = pickCorrections([agent("a", "Merged and deployed."), user("b", "Still no", 1)]);
    expect(other).toBe('- "Still no"');
  });

  it("puts the newest first", () => {
    const lines = pickCorrections([user("a", "Why is this old one here at all, explain", 1), user("b", "Why is this newer one here at all, explain", 9)]);
    expect(lines[0]).toContain("newer");
  });

  it("skips prompts sent by rules and schedules, which repeat", () => {
    const repeated = Array.from({ length: 6 }, (_, i) => user(`r${i}`, "Remember to check the portfolio and report", i));
    expect(pickCorrections(repeated)).toEqual([]);
  });

  it("reads the words under a quoted reply, and drops pasted images", () => {
    const [line] = pickCorrections([user("a", '[Replying to: "Done!"] Still broken ![image](/api/uploads/x.png)')]);
    expect(line).toBe('- "Still broken"');
  });

  it("keeps the list within its budget", () => {
    const many = Array.from({ length: 400 }, (_, i) => user(`c${i}`, `Why did you do thing number ${i} like that when I asked for ${"x".repeat(i % 200)}`, i % 59));
    const lines = pickCorrections(many);
    expect(lines.length).toBeLessThanOrEqual(120);
    expect(lines.join("\n").length).toBeLessThanOrEqual(14_200);
  });
});

describe("pickTrialMessages", () => {
  const keepOrder = () => 0.999;

  it("uses only the opening request of each conversation", () => {
    const messages = pickTrialMessages([
      user("a", "Find me a good burrito recipe for tonight", 1),
      user("a", "And then one more thing for the same chat", 2),
      user("b", "Why is the deploy pipeline so slow these days?", 3),
    ], 3, keepOrder);
    expect(messages.sort()).toEqual(["Find me a good burrito recipe for tonight", "Why is the deploy pipeline so slow these days?"]);
  });

  it("skips tests, commands, links and anything too short or too long", () => {
    expect(pickTrialMessages([
      user("a", "test"),
      user("b", "Hi there, this is only a test of the thing"),
      user("c", "/chomp-dev fix the thing in the settings page"),
      user("d", "https://example.com/a-very-long-link-to-somewhere"),
      user("e", "x".repeat(400)),
    ], 3, keepOrder)).toEqual([]);
  });

  it("returns at most what was asked for, with no repeats", () => {
    const rows = ["one", "two", "three", "four", "two"].map((n, i) => user(`c${i}`, `Please look into problem number ${n} for me`, i));
    const messages = pickTrialMessages(rows, 3, Math.random);
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(3);
  });
});
