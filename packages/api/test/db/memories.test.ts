import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { memories } from "../../src/db/schema.js";
vi.mock("../../src/db/embeddings.js", () => {
  const cosineSimilarity = (a: number[], b: number[]) =>
    a.reduce((sum, x, i) => sum + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);
  return {
    embeddingModelId: () => "test",
    generateEmbedding: async () => [1, 0],
    cosineSimilarity,
    semanticSearch: <T,>(q: number[], cands: Array<{ item: T; embedding: number[] }>, topK: number, threshold: number) =>
      cands
        .map(({ item, embedding }) => ({ item, score: cosineSimilarity(q, embedding) }))
        .filter((r) => r.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK),
  };
});

import {
  saveMemory,
  updateMemory,
  retireMemory,
  recallMemoriesSemantic,
  getMemoryById,
  getAllMemories,
  recallMemories,
  getMemoriesForPrompt,
  buildMemoryContext,
  isStated,
  CORE_CATEGORIES,
  RETRIEVAL_CATEGORIES,
} from "../../src/db/memories.js";
import { randomUUID } from "crypto";

/** Insert directly — bypasses saveMemory's fire-and-forget embedding call. */
function insert(overrides: Partial<typeof memories.$inferInsert> = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(memories)
    .values({
      id,
      agentId: null,
      content: "a memory",
      category: "facts",
      source: "user",
      confidence: 100,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .run();
  return id;
}

beforeEach(() => {
  db.delete(memories).run();
});

describe("memory prompt tiering", () => {
  it("returns an empty string when there are no memories", () => {
    expect(getMemoriesForPrompt()).toBe("");
  });

  it("injects core categories verbatim, without truncation", () => {
    // Well past the old 500-char cap that silently amputated content.
    const long = "INSTRUCTION-START " + "x".repeat(1500) + " INSTRUCTION-END";
    insert({ category: "instructions", content: long });

    const text = getMemoriesForPrompt();

    expect(text).toContain("INSTRUCTION-START");
    expect(text).toContain("INSTRUCTION-END");
    expect(text).not.toContain("...");
  });

  it("summarises retrieval-tier memories into an index instead of injecting them", () => {
    const long = "LESSON-START " + "y".repeat(1500) + " LESSON-END";
    const id = insert({ category: "lessons", content: long });

    const text = getMemoriesForPrompt();

    expect(text).toContain("[index — summaries only]");
    expect(text).toContain(id);
    expect(text).toContain("LESSON-START");
    // The tail is deliberately not injected — it's reachable via recall_memories.
    expect(text).not.toContain("LESSON-END");
  });

  it("excludes auto-extracted memories from the always-injected core tier", () => {
    insert({ category: "instructions", content: "STATED-RULE", source: "user" });
    insert({ category: "instructions", content: "DERIVED-RULE", source: "auto" });

    const text = getMemoriesForPrompt();
    const coreSection = text.slice(0, text.indexOf("[index"));

    expect(coreSection).toContain("STATED-RULE");
    expect(coreSection).not.toContain("DERIVED-RULE");
    // Still discoverable, just demoted to the index.
    expect(text).toContain("DERIVED-RULE");
  });

  it("classifies sources as stated or derived", () => {
    expect(isStated("user")).toBe(true);
    expect(isStated("seed")).toBe(true);
    expect(isStated("auto")).toBe(false);
  });

  it("keeps core and retrieval category lists disjoint", () => {
    for (const c of CORE_CATEGORIES) {
      expect(RETRIEVAL_CATEGORIES).not.toContain(c);
    }
  });
});

describe("memory prompt budget", () => {
  it("stays within the character budget and reports what it dropped", async () => {
    for (let i = 0; i < 60; i++) {
      insert({ category: "lessons", content: `lesson ${i} ` + "z".repeat(400) });
    }

    const budget = 4000;
    const { text, stats } = await buildMemoryContext({ charBudget: budget });

    expect(text.length).toBeLessThanOrEqual(budget);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(text).toContain("omitted — character budget reached");
  });

  it("drops whole entries rather than cutting one mid-sentence", async () => {
    for (let i = 0; i < 40; i++) {
      insert({ category: "instructions", content: `RULE${i}-` + "q".repeat(300) });
    }

    const { text } = await buildMemoryContext({ charBudget: 3000 });

    // Every RULEn that appears must appear with its full 300-char payload.
    for (const match of text.matchAll(/RULE(\d+)-(q*)/g)) {
      expect(match[2].length).toBe(300);
    }
  });

  it("prioritises core memories over the index when space is tight", async () => {
    insert({ category: "instructions", content: "CRITICAL-STANDING-ORDER" });
    for (let i = 0; i < 40; i++) {
      insert({ category: "lessons", content: `lesson ${i} ` + "w".repeat(300) });
    }

    const { text, stats } = await buildMemoryContext({ charBudget: 1200 });

    expect(text).toContain("CRITICAL-STANDING-ORDER");
    expect(stats.core).toBe(1);
  });

  it("is dramatically smaller than injecting everything verbatim", async () => {
    let verbatim = 0;
    for (let i = 0; i < 90; i++) {
      const content = `lesson ${i} ` + "e".repeat(700);
      verbatim += content.length;
      insert({ category: "lessons", content });
    }

    const { text } = await buildMemoryContext();

    expect(text.length).toBeLessThan(verbatim / 3);
  });
});

describe("claims: evidence and supersession", () => {
  it("stores the evidence a memory came from", () => {
    const m = saveMemory({ content: "uses pnpm", category: "instructions", source: "auto", evidenceQuote: "always use pnpm", evidenceMessageId: "msg-1" });
    expect(getMemoryById(m.id)).toMatchObject({ evidenceQuote: "always use pnpm", evidenceMessageId: "msg-1", status: "active" });
  });

  it("lets a newer auto memory replace an older auto one, hiding it but keeping the row", () => {
    const old = saveMemory({ content: "moving away from Chomp", category: "project-context", source: "auto" });
    const next = saveMemory({ content: "back on Chomp", category: "project-context", source: "auto", supersedesId: old.id });

    expect(next.supersedesId).toBe(old.id);
    expect(getMemoryById(old.id)?.status).toBe("superseded");
    const visible = getAllMemories().map((m) => m.id);
    expect(visible).toContain(next.id);
    expect(visible).not.toContain(old.id);
    const recalled = recallMemories({ query: "Chomp", limit: 100 }).map((m) => m.id);
    expect(recalled).toContain(next.id);
    expect(recalled).not.toContain(old.id);
  });

  it("never lets an auto memory replace a stated one", () => {
    const stated = saveMemory({ content: "tag testuser on PRs", category: "instructions", source: "user" });
    const next = saveMemory({ content: "do not tag anyone", category: "instructions", source: "auto", supersedesId: stated.id });

    expect(next.supersedesId).toBeNull();
    expect(getMemoryById(stated.id)?.status).toBe("active");
    expect(getMemoryById(next.id)?.status).toBe("active");
  });

  it("retires instead of erasing: hidden from prompts and recall, row kept, only once", () => {
    const id = insert({ content: "sqlite3 is installed", category: "lessons" });

    expect(retireMemory(id)).toBe(true);
    expect(getMemoryById(id)?.status).toBe("retired");
    expect(getAllMemories().map((m) => m.id)).not.toContain(id);
    expect(recallMemories({ query: "sqlite3", limit: 100 }).map((m) => m.id)).not.toContain(id);
    expect(retireMemory(id)).toBe(false);
    expect(retireMemory("missing")).toBe(false);
  });

  it("ignores a supersedes id that does not exist", () => {
    const m = saveMemory({ content: "a fact", category: "facts", source: "auto", supersedesId: "nope" });
    expect(m.supersedesId).toBeNull();
  });
});

describe("updateMemory", () => {
  it("re-embeds a rewritten memory so recall does not match its old wording", async () => {
    const id = insert({ content: "uses npm", embedding: JSON.stringify([0, 1]), embeddingModel: "test" });

    updateMemory(id, "uses pnpm");

    // The mocked embedder returns [1, 0]; the old vector was [0, 1].
    await vi.waitFor(() => expect(JSON.parse(getMemoryById(id)!.embedding!)).toEqual([1, 0]));
    expect(getMemoryById(id)?.content).toBe("uses pnpm");
  });
});

describe("recallMemoriesSemantic ranking", () => {
  it("keeps the best semantic match first even when a weaker match is newer", async () => {
    // The mocked query vector is [1, 0]: "exact" matches it perfectly, "newer-weak" only at cosine 0.6.
    const exact = insert({ content: "exact match", embedding: JSON.stringify([1, 0]), embeddingModel: "test", createdAt: "2026-01-01T00:00:00.000Z" });
    const weak = insert({ content: "newer, weaker match", embedding: JSON.stringify([0.6, 0.8]), embeddingModel: "test", createdAt: new Date().toISOString() });

    const ids = (await recallMemoriesSemantic({ query: "anything", limit: 100 })).map((m) => m.id);

    expect(ids.indexOf(exact)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(exact)).toBeLessThan(ids.indexOf(weak));
  });
});

describe("recallMemoriesSemantic across embedding models", () => {
  it("compares only vectors from the current model", async () => {
    db.delete(memories).run();
    db.insert(memories).values({ id: randomUUID(), content: "other model", category: "facts", source: "user", confidence: 80, embedding: JSON.stringify([1, 0]), embeddingModel: "old-model", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
    db.insert(memories).values({ id: randomUUID(), content: "current model", category: "facts", source: "user", confidence: 80, embedding: JSON.stringify([1, 0]), embeddingModel: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
    const found = await recallMemoriesSemantic({ query: "anything", limit: 5 });
    expect(found.map((m) => m.content)).toEqual(["current model"]);
  });
});
