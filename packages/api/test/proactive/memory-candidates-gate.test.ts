import { expect, test } from "vitest";
import { memoryCandidates } from "../../src/proactive/script-gates.js";
import type { MemoryRecord } from "../../src/db/memories.js";

const DAY = 86_400_000;
const now = Date.parse("2026-11-03T12:00:00Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();

function mem(id: string, o: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, agentId: null, content: id, category: "facts", embedding: null, embeddingModel: null, source: "auto",
    sourceConversationId: null, confidence: 100, status: "active", supersedesId: null, evidenceQuote: null,
    evidenceMessageId: null, createdAt: ago(1), updatedAt: ago(1), ...o,
  };
}

test("does not match, so no agent boots, when no auto memory is fresh", () => {
  const result = memoryCandidates([mem("old", { createdAt: ago(30) }), mem("stated", { source: "user" })], 8, now);

  expect(result.matched).toBe(false);
  expect(result.summary).toContain("no new auto memories");
});

test("hands over only fresh active auto memories, each with its nearest neighbours", () => {
  const all = [
    mem("stated", { source: "user", category: "instructions", embedding: JSON.stringify([1, 0]) }),
    mem("unrelated", { source: "user", embedding: JSON.stringify([0, 1]) }),
    mem("old-auto", { createdAt: ago(30) }),
    mem("superseded-auto", { status: "superseded" }),
    mem("fresh", { category: "instructions", evidenceQuote: "tag me as reviewer", supersedesId: "x", embedding: JSON.stringify([0.99, 0.1]) }),
  ];

  const result = memoryCandidates(all, 8, now);

  expect(result.matched).toBe(true);
  const { candidates } = result.data as { candidates: Array<{ id: string; evidence: string; replaces: string; neighbours: Array<{ id: string; similarity: number }> }> };
  expect(candidates.map((c) => c.id)).toEqual(["fresh"]);
  expect(candidates[0]).toMatchObject({ evidence: "tag me as reviewer", replaces: "x" });
  expect(candidates[0].neighbours.map((n) => n.id)).toEqual(["stated"]);
  expect(candidates[0].neighbours[0].similarity).toBeGreaterThan(0.9);
});
