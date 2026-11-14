import { db } from "./index.js";
import { memories } from "./schema.js";
import { eq, like, and, isNull, or, type SQL } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface MemoryInput {
  content: string;
  category: string;
  agentId?: string | null;
  source?: string;
  sourceConversationId?: string;
  confidence?: number;
  evidenceQuote?: string;
  evidenceMessageId?: string;
  /** Memory this one replaces. Honoured only when the replaced one is active and the
   *  replacement is not a derived memory overriding a stated one (see saveMemory). */
  supersedesId?: string;
}

export interface MemoryRecord {
  id: string;
  agentId: string | null;
  content: string;
  category: string;
  embedding: string | null;
  embeddingModel: string | null;
  source: string;
  sourceConversationId: string | null;
  confidence: number;
  status: string;
  supersedesId: string | null;
  evidenceQuote: string | null;
  evidenceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Last embedding failure, surfaced in the health report. Embedding generation
 * is fire-and-forget, so without this a broken embedding model is invisible
 * until someone notices recall has quietly become a LIKE query.
 */
let lastEmbeddingFailure: { message: string; at: string } | null = null;

function recordEmbeddingFailure(message: string): void {
  lastEmbeddingFailure = { message, at: new Date().toISOString() };
}

export function getLastEmbeddingFailure(): { message: string; at: string } | null {
  return lastEmbeddingFailure;
}

/** Count of memories still missing an embedding — drives the health check. */
export function countMemoriesMissingEmbeddings(): { total: number; missing: number } {
  const all = db.select().from(memories).all();
  return {
    total: all.length,
    missing: all.filter((m) => !m.embedding).length,
  };
}

export function saveMemory(input: MemoryInput): MemoryRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const source = input.source ?? "user";

  // A derived (auto) memory may only replace another derived one: stated memories are
  // the user's own word and stay until a human edits them.
  const old = input.supersedesId ? getMemoryById(input.supersedesId) : undefined;
  const supersedesId = old && old.status === "active" && (source !== "auto" || old.source === "auto") ? old.id : null;

  db.transaction((tx) => {
    tx.insert(memories).values({
      id,
      agentId: input.agentId ?? null,
      content: input.content,
      category: input.category,
      source,
      sourceConversationId: input.sourceConversationId ?? null,
      confidence: input.confidence ?? 100,
      evidenceQuote: input.evidenceQuote ?? null,
      evidenceMessageId: input.evidenceMessageId ?? null,
      supersedesId,
      createdAt: now,
      updatedAt: now,
    }).run();
    if (supersedesId) {
      tx.update(memories).set({ status: "superseded", updatedAt: now }).where(eq(memories.id, supersedesId)).run();
    }
  });

  embedInBackground(id, input.content);

  const result = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!result) {
    throw new Error(`Failed to save memory: insert succeeded but row not found (id: ${id})`);
  }
  return result;
}

/**
 * Generate and store an embedding without blocking the caller (fire-and-forget).
 * Failures here are not fatal, but they silently downgrade every future
 * recall to substring matching, so they are logged at error level and
 * recorded for the health report rather than whispered as a warning.
 */
function embedInBackground(id: string, content: string): void {
  generateAndSaveEmbedding(id, content).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    recordEmbeddingFailure(message);
    console.error(
      `[memories] EMBEDDING FAILED for ${id} (${message}). ` +
        `Semantic recall is degraded to substring matching until this is fixed — ` +
        `check the embedding model under Settings → AI and chat.`,
    );
  });
}

/** Generate and persist embedding for a memory */
async function generateAndSaveEmbedding(id: string, content: string): Promise<void> {
  const { generateEmbedding, embeddingModelId } = await import("./embeddings.js");
  const EMBEDDING_MODEL = embeddingModelId();
  const embedding = await generateEmbedding(content);
  db.update(memories).set({
    embedding: JSON.stringify(embedding),
    embeddingModel: EMBEDDING_MODEL,
    updatedAt: new Date().toISOString(),
  }).where(eq(memories.id, id)).run();
}

export function recallMemories(options: {
  query?: string;
  category?: string;
  agentId?: string | null;
  limit?: number;
}): MemoryRecord[] {
  const { query, category, agentId, limit = 20 } = options;

  const conditions: (SQL | undefined)[] = [eq(memories.status, "active")];

  if (category) {
    conditions.push(eq(memories.category, category));
  }

  if (agentId !== undefined) {
    if (agentId === null) {
      conditions.push(isNull(memories.agentId));
    } else if (agentId) {
      conditions.push(
        or(eq(memories.agentId, agentId), isNull(memories.agentId)),
      );
    }
  }

  // Fall back to LIKE search (semantic search is async — use recallMemoriesSemantic for that)
  if (query) {
    conditions.push(like(memories.content, `%${query}%`));
  }

  let q = db.select().from(memories);
  if (conditions.length > 0) {
    q = q.where(and(...conditions)) as typeof q;
  }

  return q.limit(limit).all();
}

/**
 * Recency only breaks near-ties between equally relevant memories. At 30% it outvoted meaning
 * (nomic-embed similarities cluster, so a newer weak match beat the best match), and the right
 * memory fell out of the top results for queries like "what is the user's employer".
 */
const RECENCY_WEIGHT = 0.05;

/** Semantic recall — uses embeddings when available, falls back to LIKE search.
 *  Scores are hybrid: semantic similarity plus a small recency bonus (newer = higher). */
export async function recallMemoriesSemantic(options: {
  query: string;
  category?: string;
  agentId?: string | null;
  limit?: number;
  threshold?: number;
}): Promise<MemoryRecord[]> {
  const { query, category, agentId, limit = 10, threshold = 0.3 } = options;

  // Get all candidate memories (filtered by category/agent)
  const conditions: (SQL | undefined)[] = [eq(memories.status, "active")];
  if (category) conditions.push(eq(memories.category, category));
  if (agentId !== undefined) {
    if (agentId === null) {
      conditions.push(isNull(memories.agentId));
    } else if (agentId) {
      conditions.push(or(eq(memories.agentId, agentId), isNull(memories.agentId)));
    }
  }

  let q = db.select().from(memories);
  if (conditions.length > 0) {
    q = q.where(and(...conditions)) as typeof q;
  }
  const allMemories = q.all();

  // Only vectors from the current model are comparable; the rest wait for the backfill.
  const { embeddingModelId } = await import("./embeddings.js");
  const currentModel = embeddingModelId();
  const withEmbeddings = allMemories.filter((m) => m.embedding && m.embeddingModel === currentModel);
  if (withEmbeddings.length === 0) {
    // Fall back to LIKE search
    return recallMemories({ query, category, agentId, limit });
  }

  try {
    const { generateEmbedding, semanticSearch } = await import("./embeddings.js");
    const queryEmbedding = await generateEmbedding(query);

    const candidates = withEmbeddings.map((m) => ({
      item: m,
      embedding: JSON.parse(m.embedding!) as number[],
    }));

    const semanticResults = semanticSearch(queryEmbedding, candidates, withEmbeddings.length, threshold);

    if (semanticResults.length === 0) {
      // Nothing cleared threshold — fall back to substring search
      return recallMemories({ query, category, agentId, limit });
    }

    // Hybrid scoring: semantic similarity plus a small recency tie-breaker
    // Recency score: normalise createdAt timestamps to [0, 1] within the result set
    const timestamps = semanticResults.map((r) => new Date(r.item.createdAt).getTime());
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const tsRange = maxTs - minTs || 1; // avoid division by zero

    const hybrid = semanticResults.map((r) => {
      const recencyScore = (new Date(r.item.createdAt).getTime() - minTs) / tsRange;
      return { item: r.item, score: (1 - RECENCY_WEIGHT) * r.score + RECENCY_WEIGHT * recencyScore };
    });

    hybrid.sort((a, b) => b.score - a.score);
    return hybrid.slice(0, limit).map((r) => r.item);
  } catch {
    // Embedding model unavailable — fall back to LIKE
    return recallMemories({ query, category, agentId, limit });
  }
}

export interface BackfillResult {
  total: number;
  embedded: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Populate embeddings for memories that are missing one (or were embedded with
 * a different model). Safe to re-run — it only writes rows it actually embeds.
 */
export async function backfillEmbeddings(options: {
  force?: boolean;
  onProgress?: (done: number, total: number, content: string) => void;
} = {}): Promise<BackfillResult> {
  const { force = false, onProgress } = options;
  const { generateEmbedding, embeddingModelId } = await import("./embeddings.js");
  const EMBEDDING_MODEL = embeddingModelId();

  const all = db.select().from(memories).all();
  const targets = all.filter(
    (m) => force || !m.embedding || m.embeddingModel !== EMBEDDING_MODEL,
  );

  const result: BackfillResult = {
    total: all.length,
    embedded: 0,
    skipped: all.length - targets.length,
    failed: 0,
    errors: [],
  };

  let done = 0;
  for (const m of targets) {
    try {
      const embedding = await generateEmbedding(m.content);
      db.update(memories)
        .set({
          embedding: JSON.stringify(embedding),
          embeddingModel: EMBEDDING_MODEL,
          // Deliberately NOT touching updatedAt — this is a storage-level
          // backfill, not a content edit, and updatedAt drives recency scoring.
        })
        .where(eq(memories.id, m.id))
        .run();
      result.embedded++;
    } catch (err) {
      result.failed++;
      result.errors.push(`${m.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    onProgress?.(++done, targets.length, m.content);
  }

  return result;
}

export function getMemoryById(id: string): MemoryRecord | undefined {
  return db.select().from(memories).where(eq(memories.id, id)).get();
}

export function updateMemory(id: string, content: string): MemoryRecord | undefined {
  const existing = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!existing) return undefined;

  db.update(memories).set({
    content,
    updatedAt: new Date().toISOString(),
  }).where(eq(memories.id, id)).run();

  // The stored vector describes the OLD text; without this, recall and duplicate
  // detection keep matching a memory by what it used to say.
  embedInBackground(id, content);

  return db.select().from(memories).where(eq(memories.id, id)).get() ?? undefined;
}

export function deleteMemory(id: string): boolean {
  const existing = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!existing) return false;

  db.delete(memories).where(eq(memories.id, id)).run();
  return true;
}

/**
 * What an agent's delete does: the row stays, hidden like a superseded one, so
 * a bad cleanup (a dream, a confused agent) can be undone. Deletes from the UI
 * stay real deletes, so whatever the user removes is actually gone.
 */
export function retireMemory(id: string): boolean {
  const result = db
    .update(memories)
    .set({ status: "retired", updatedAt: new Date().toISOString() })
    .where(and(eq(memories.id, id), eq(memories.status, "active")))
    .run();
  return result.changes > 0;
}

/** Active memories only: superseded ones stay in the table but never reach a prompt or a listing. */
export function getAllMemories(): MemoryRecord[] {
  return db.select().from(memories).where(eq(memories.status, "active")).all();
}


// ── Prompt context construction ────────────────────────────────────
//
// Memory is injected in tiers rather than as one undifferentiated dump.
//
//   core      — standing instructions and identity. Always injected VERBATIM.
//               These must reach the model deterministically; "always tag
//               the configured maintainer as reviewer" cannot be subject to a relevance score.
//   recalled  — retrieval-tier entries that semantically match the incoming
//               message. Injected verbatim, capped at RECALL_TOP_K.
//   index     — every remaining retrieval-tier entry, as a one-line headline
//               plus its id, so the agent knows the memory EXISTS and can pull
//               the full text with recall_memories.
//
// Two invariants:
//   1. A memory is never truncated mid-sentence inside the core or recalled
//      tiers. If the budget is tight we drop whole entries and say so. The
//      previous 500-char hard cut silently amputated 30k characters of stored
//      content, mostly from the long-form `lessons` entries.
//   2. Auto-extracted (derived) memories are never auto-injected. They are
//      retrieval-only until a human promotes them by editing the entry.

export const ALLOWED_CATEGORIES = [
  "preferences",
  "project-context",
  "facts",
  "instructions",
  "lessons",
];

/** Categories injected verbatim on every prompt. */
export const CORE_CATEGORIES = ["instructions", "preferences", "facts"];

/** Categories reached via recall + headline index rather than full injection. */
export const RETRIEVAL_CATEGORIES = ["lessons", "project-context"];

/** Order categories appear in the core block — instructions lead deliberately. */
const CORE_ORDER = ["instructions", "preferences", "facts"];

/**
 * Total character budget for the <stored-memories> block.
 * ~32k chars ≈ 8k tokens. Tune via MEMORY_PROMPT_CHAR_BUDGET.
 */
const PROMPT_CHAR_BUDGET = Number(process.env.MEMORY_PROMPT_CHAR_BUDGET ?? 32_000);

/** Max chars for a single index headline (these are summaries by design). */
const INDEX_HEADLINE_CHARS = 110;

/** How many semantically-matched retrieval-tier memories to inject in full. */
const RECALL_TOP_K = Number(process.env.MEMORY_RECALL_TOP_K ?? 4);

/**
 * Sources whose memories are trusted enough to inject without being asked for.
 * `auto` (LLM-extracted) is deliberately excluded — see invariant 2 above.
 */
const STATED_SOURCES = new Set(["user", "seed", "import"]);

export function isStated(source: string): boolean {
  return STATED_SOURCES.has(source);
}

/**
 * Strip formatting that would let a memory break out of its list context.
 * Note: no length truncation — callers decide whether to summarise or drop.
 */
function sanitizeMemoryContent(content: string): string {
  return content
    .replace(/^#+\s/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

/** Cut to a word boundary and mark it as elided, for index lines only. */
function headline(content: string): string {
  const flat = sanitizeMemoryContent(content);
  if (flat.length <= INDEX_HEADLINE_CHARS) return flat;
  const cut = flat.slice(0, INDEX_HEADLINE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > INDEX_HEADLINE_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function normalizeCategory(category: string): string {
  return ALLOWED_CATEGORIES.includes(category) ? category : "other";
}

/** Memories visible to this agent: global (null agentId) plus its own. */
function visibleMemories(agentId?: string): MemoryRecord[] {
  return db
    .select()
    .from(memories)
    .all()
    .filter((m) => !m.agentId || m.agentId === agentId);
}

export interface MemoryContextOptions {
  agentId?: string;
  /** Incoming user message — enables semantic pull of relevant lessons. */
  query?: string;
  /** Override the character budget (tests, constrained models). */
  charBudget?: number;
}

export interface MemoryContextResult {
  text: string;
  stats: {
    core: number;
    recalled: number;
    indexed: number;
    dropped: number;
    chars: number;
  };
}

/**
 * Build the tiered <stored-memories> block.
 *
 * Async because the recalled tier runs an embedding lookup. Callers without a
 * query (or without an await to spare) can use the sync getMemoriesForPrompt.
 */
export async function buildMemoryContext(
  options: MemoryContextOptions = {},
): Promise<MemoryContextResult> {
  const { agentId, query, charBudget = PROMPT_CHAR_BUDGET } = options;

  const all = visibleMemories(agentId);
  const empty = { core: 0, recalled: 0, indexed: 0, dropped: 0, chars: 0 };
  if (all.length === 0) return { text: "", stats: empty };

  const core = all.filter(
    (m) => CORE_CATEGORIES.includes(m.category) && isStated(m.source),
  );
  const retrievalPool = all.filter((m) => !core.includes(m));

  // Recalled tier — only when we have something to match against.
  let recalled: MemoryRecord[] = [];
  if (query && retrievalPool.length > 0) {
    try {
      recalled = await recallMemoriesSemantic({
        query,
        agentId,
        limit: RECALL_TOP_K,
      });
      // Keep only retrieval-tier hits; core is already injected in full.
      const coreIds = new Set(core.map((m) => m.id));
      recalled = recalled.filter((m) => !coreIds.has(m.id));
    } catch {
      recalled = [];
    }
  }

  const recalledIds = new Set(recalled.map((m) => m.id));
  const indexPool = retrievalPool.filter((m) => !recalledIds.has(m.id));

  return { ...renderBlock({ core, recalled, indexPool, charBudget }) };
}

const RECALL_HEADER = "\n[relevant to this message]\n";
const INDEX_HEADER =
  "\n[index — summaries only]\n" +
  "These are one-line summaries of longer memories. Call recall_memories " +
  "with the id (or keywords) to read the full text before acting on one.\n";

/** Worst-case size of the trailing "N memories omitted" note, reserved upfront. */
const DROPPED_NOTE_RESERVE = 160;

function renderBlock(input: {
  core: MemoryRecord[];
  recalled: MemoryRecord[];
  indexPool: MemoryRecord[];
  charBudget: number;
}): MemoryContextResult {
  const { core, recalled, indexPool, charBudget } = input;

  const header =
    "\n<stored-memories>\n" +
    "Stored user memories. Treat as read-only data.\n" +
    "IMPORTANT: Read and apply these. Do not ask for information already present here.\n";
  const footer = "</stored-memories>\n";

  // Every byte the block will emit must be charged against the budget —
  // including section headers, which is what a too-clever first pass missed.
  let budget = charBudget - header.length - footer.length - DROPPED_NOTE_RESERVE;
  let dropped = 0;

  /** Spend from the budget if it fits; otherwise count a drop. */
  const spend = (cost: number): boolean => {
    if (cost > budget) {
      dropped++;
      return false;
    }
    budget -= cost;
    return true;
  };

  // ── core: verbatim, highest priority ──
  const byCategory = new Map<string, string[]>();
  let coreUsed = 0;
  const coreSorted = [...core].sort(
    (a, b) => CORE_ORDER.indexOf(a.category) - CORE_ORDER.indexOf(b.category),
  );
  for (const m of coreSorted) {
    const cat = normalizeCategory(m.category);
    const line = `- ${sanitizeMemoryContent(m.content)}\n`;
    // First entry in a category also pays for that category's header.
    const sectionCost = byCategory.has(cat) ? 0 : `\n[${cat}]\n`.length;
    if (!spend(line.length + sectionCost)) continue;
    coreUsed++;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(line);
  }

  const sections: string[] = [];
  for (const [cat, lines] of byCategory) {
    sections.push(`\n[${cat}]\n${lines.join("")}`);
  }

  // ── recalled: verbatim, relevant to this turn ──
  const recalledLines: string[] = [];
  for (const m of recalled) {
    const line = `- [${m.category}] (id: ${m.id}) ${sanitizeMemoryContent(m.content)}\n`;
    const sectionCost = recalledLines.length === 0 ? RECALL_HEADER.length : 0;
    if (!spend(line.length + sectionCost)) continue;
    recalledLines.push(line);
  }
  if (recalledLines.length > 0) {
    sections.push(RECALL_HEADER + recalledLines.join(""));
  }

  // ── index: headlines only, newest first so recent lessons survive a squeeze ──
  const indexSorted = [...indexPool].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const indexLines: string[] = [];
  for (const m of indexSorted) {
    const line = `- [${m.category}] (id: ${m.id}) ${headline(m.content)}\n`;
    const sectionCost = indexLines.length === 0 ? INDEX_HEADER.length : 0;
    if (!spend(line.length + sectionCost)) continue;
    indexLines.push(line);
  }
  if (indexLines.length > 0) {
    sections.push(INDEX_HEADER + indexLines.join(""));
  }

  if (dropped > 0) {
    sections.push(
      `\n[${dropped} further memor${dropped === 1 ? "y" : "ies"} omitted — character budget reached. Use recall_memories to search them.]\n`,
    );
  }

  const text = header + sections.join("") + footer;
  return {
    text,
    stats: {
      core: coreUsed,
      recalled: recalledLines.length,
      indexed: indexLines.length,
      dropped,
      chars: text.length,
    },
  };
}

/**
 * Synchronous tiered context, for call sites that have no incoming query or
 * cannot await. Same tiering and budget as buildMemoryContext, minus the
 * semantically-recalled tier.
 */
export function getMemoriesForPrompt(agentId?: string): string {
  const all = visibleMemories(agentId);
  if (all.length === 0) return "";

  const core = all.filter(
    (m) => CORE_CATEGORIES.includes(m.category) && isStated(m.source),
  );
  const indexPool = all.filter((m) => !core.includes(m));

  return renderBlock({
    core,
    recalled: [],
    indexPool,
    charBudget: PROMPT_CHAR_BUDGET,
  }).text;
}
