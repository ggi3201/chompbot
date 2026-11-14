import { beforeEach, describe, expect, it, vi } from "vitest";

const backgroundCompletion = vi.hoisted(() => vi.fn());
const saveMemory = vi.hoisted(() => vi.fn());
const related = vi.hoisted(() => ({ rows: [] as Array<{ id: string; content: string }> }));

vi.mock("../../src/lib/background-model.js", () => ({ backgroundCompletion }));
// Stubbed store: test files share one DB file, so this suite stays off it. Saving and
// supersession themselves are covered in db/memories.test.ts.
vi.mock("../../src/db/memories.js", () => ({
  saveMemory,
  recallMemories: () => [],
  recallMemoriesSemantic: async () => related.rows,
}));

import { acceptMemories, extractMemories, type ExtractionInput } from "../../src/memory/extractor.js";

const input: ExtractionInput = {
  userMessage: "No, always use pnpm in the chomp repo, never npm",
  assistantResponse: "Switching to pnpm.",
  recentTurns: [{ role: "user", content: "dont touch the foodie repo" }],
  conversationId: "conv-1",
  messageId: "msg-1",
};
const pnpm = { content: "In the chomp repo always use pnpm, never npm.", category: "instructions", durable: true, evidence: "always use pnpm in the chomp repo", supersedes: null };

function modelReturns(structured: unknown) {
  backgroundCompletion.mockResolvedValue(JSON.stringify(structured));
}

beforeEach(() => {
  vi.clearAllMocks();
  related.rows = [];
});

describe("acceptMemories", () => {
  it("keeps durable memories backed by a verbatim quote, and rejects the rest", () => {
    const kept = acceptMemories(
      [
        pnpm,
        { ...pnpm, content: "task, not a memory", durable: false },
        { ...pnpm, content: "invented", evidence: "the user loves tabs over spaces" },
        { ...pnpm, content: "bad category", category: "lessons" },
        { ...pnpm, content: "unknown replacement", supersedes: "no-such-id" },
        { ...pnpm, content: "from an earlier user turn", evidence: "dont touch the foodie repo" },
      ],
      input,
      new Set(["abc"]),
    );

    expect(kept.map((m) => m.content)).toEqual([pnpm.content, "unknown replacement", "from an earlier user turn"]);
    expect(kept[1].supersedes).toBeNull();
  });

  it("matches the quote ignoring case and whitespace", () => {
    const kept = acceptMemories([{ ...pnpm, evidence: "ALWAYS  use pnpm\nin the chomp repo" }], input, new Set());
    expect(kept).toHaveLength(1);
  });
});

describe("extractMemories", () => {
  it("asks the background model with the related memories and a schema, and saves with evidence and a supersession", async () => {
    related.rows = [{ id: "old-claim", content: "uses npm in chomp" }];
    modelReturns({ memories: [{ ...pnpm, supersedes: "old-claim" }] });

    await extractMemories(input);

    const request = backgroundCompletion.mock.calls[0][0];
    expect(request.schema).toBeDefined();
    expect(request.prompt).toContain("[old-claim] uses npm in chomp");
    expect(request.prompt).toContain("user: dont touch the foodie repo");
    expect(saveMemory).toHaveBeenCalledWith({
      content: pnpm.content,
      category: "instructions",
      agentId: null,
      source: "auto",
      sourceConversationId: "conv-1",
      evidenceQuote: "always use pnpm in the chomp repo",
      evidenceMessageId: "msg-1",
      supersedesId: "old-claim",
    });
  });

  it("saves nothing when no model answers, without logging the user's words", async () => {
    backgroundCompletion.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await extractMemories(input);

    expect(saveMemory).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("pnpm");
  });

  it("saves nothing when the quote is not in the user's words", async () => {
    modelReturns({ memories: [{ ...pnpm, evidence: "i never said this" }] });

    await extractMemories(input);

    expect(saveMemory).not.toHaveBeenCalled();
  });
});
