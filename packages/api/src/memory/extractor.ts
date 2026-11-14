import { backgroundCompletion } from "../lib/background-model.js";
import { saveMemory, recallMemories, recallMemoriesSemantic } from "../db/memories.js";
import { extractJson } from "../lib/extract-json.js";

const EXTRACTION_PROMPT = `You maintain the long-term memory of one user. From the conversation excerpt, extract only DURABLE knowledge the USER stated: facts about them or their world, standing preferences, standing instructions.

Rules:
- Extract ONLY from the USER MESSAGE below. RECENT TURNS exist to resolve references ("those repos", "it") and are never a source of new memories.
- Use the recent turns to resolve references. Each memory must make sense on its own and name the actual things, never "certain repos" or "this skill".
- NEVER save tasks or one-off requests (install X, change the favicon, fix this bug, build a page). Anything phrased as "can we...", "make it..." or "fix..." is a task even if it implies a preference. Also never save questions, status of what is being worked on, or anything that will be stale within weeks.
- NEVER save things only the assistant said, and NEVER save secrets (passwords, API keys, tokens).
- Save only what would change how an assistant behaves or what it assumes in future conversations. Skip trivia such as the mere existence of a project or feature.
- "evidence" is a short verbatim quote (max 200 chars) from the USER's messages that supports the memory.
- If a new memory replaces or contradicts one of the RELATED EXISTING MEMORIES, set "supersedes" to that memory's id. If it only restates one, do not save it.
- Most turns contain nothing worth saving. Return {"memories": []} for those.

Respond with JSON only: {"memories":[{"content":"...","category":"preferences|facts|project-context|instructions","durable":true,"evidence":"...","supersedes":null}]}`;

const EXTRACTION_SCHEMA = {
  type: "object",
  required: ["memories"],
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        required: ["content", "category", "durable", "evidence", "supersedes"],
        properties: {
          content: { type: "string" },
          category: { type: "string", enum: ["preferences", "facts", "project-context", "instructions"] },
          durable: { type: "boolean" },
          evidence: { type: "string" },
          supersedes: { type: ["string", "null"] },
        },
      },
    },
  },
};

const VALID_CATEGORIES = ["preferences", "project-context", "facts", "instructions"];
const SEMANTIC_DUPE_THRESHOLD = 0.85;

export interface ExtractionInput {
  userMessage: string;
  assistantResponse: string;
  /** Turns before the current message, oldest first. Used only to resolve references. */
  recentTurns: Array<{ role: string; content: string }>;
  conversationId?: string;
  /** Id of the user's chat message, stored as the memory's evidence pointer. */
  messageId?: string;
}

interface ExtractedMemory {
  content?: string;
  category?: string;
  durable?: boolean;
  evidence?: string;
  supersedes?: string | null;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Keep only memories that are durable, in a known category, and backed by a quote that
 * really is in the user's words. A model that paraphrases or invents evidence is
 * rejected, which is what keeps a hallucinated "fact" out of the store.
 */
export function acceptMemories(
  raw: ExtractedMemory[],
  input: ExtractionInput,
  relatedIds: Set<string>,
): Array<Required<Pick<ExtractedMemory, "content" | "category" | "evidence">> & { supersedes: string | null }> {
  const haystack = normalize(
    [input.userMessage, ...input.recentTurns.filter((t) => t.role === "user").map((t) => t.content)].join(" "),
  );
  const accepted = [];
  for (const m of raw) {
    if (!m.content || !m.category || !VALID_CATEGORIES.includes(m.category) || m.durable !== true) continue;
    const quote = normalize(m.evidence ?? "");
    if (quote.length < 4 || !haystack.includes(quote)) {
      console.log(`[memory-extractor] Rejected, evidence not found in the user's words: ${m.content.slice(0, 60)}`);
      continue;
    }
    accepted.push({
      content: m.content,
      category: m.category,
      evidence: (m.evidence ?? "").trim(),
      supersedes: m.supersedes && relatedIds.has(m.supersedes) ? m.supersedes : null,
    });
  }
  return accepted;
}

/** Semantic duplicate check with embeddings (substring fallback if the model is down). */
async function isDuplicate(content: string, category: string): Promise<boolean> {
  const existing = recallMemories({ category, limit: 50 });
  if (existing.length === 0) return false;

  const withEmbeddings = existing.filter((m) => m.embedding);
  if (withEmbeddings.length > 0) {
    try {
      const { generateEmbedding, cosineSimilarity } = await import("../db/embeddings.js");
      const queryEmb = await generateEmbedding(content);
      return withEmbeddings.some((m) => cosineSimilarity(queryEmb, JSON.parse(m.embedding!) as number[]) >= SEMANTIC_DUPE_THRESHOLD);
    } catch {
      // Embedding model unavailable: fall through to the substring check.
    }
  }

  return existing.some((e) =>
    e.content.toLowerCase().includes(content.toLowerCase()) ||
    content.toLowerCase().includes(e.content.toLowerCase()),
  );
}

/**
 * Extract memories from one exchange. Async and fire-and-forget: never blocks chat.
 * Haiku through the SDK first; `fallback` (Anthropic API key, else Gemini) if that fails
 * or when the fallback is already the Anthropic API.
 */
function buildUserPrompt(input: ExtractionInput, related: Array<{ id: string; content: string }>): string {
  const turns = input.recentTurns.slice(-4).map((t) => `${t.role}: ${t.content.slice(0, 600)}`).join("\n") || "(none)";
  const rel = related.map((m) => `[${m.id}] ${m.content.slice(0, 300)}`).join("\n") || "(none)";
  return `RECENT TURNS:\n${turns}\n\nRELATED EXISTING MEMORIES:\n${rel}\n\nUSER MESSAGE:\n${input.userMessage.slice(0, 4000)}\n\nASSISTANT REPLY (start):\n${input.assistantResponse.slice(0, 500)}`;
}

export async function extractMemories(input: ExtractionInput): Promise<void> {
  try {
    let related: Array<{ id: string; content: string }> = [];
    try {
      related = (await recallMemoriesSemantic({ query: input.userMessage.slice(0, 500), limit: 5 })).map((m) => ({ id: m.id, content: m.content }));
    } catch {
      // No related memories means no supersession, nothing worse.
    }

    const userPrompt = buildUserPrompt(input, related);
    const content = await backgroundCompletion({ system: EXTRACTION_PROMPT, prompt: userPrompt, schema: EXTRACTION_SCHEMA });
    if (!content) return;

    const parsed = JSON.parse(extractJson(content)) as { memories?: ExtractedMemory[] };
    const accepted = acceptMemories(parsed.memories ?? [], input, new Set(related.map((m) => m.id)));

    for (const mem of accepted) {
      if (!mem.supersedes && (await isDuplicate(mem.content, mem.category))) {
        console.log(`[memory-extractor] Skipped duplicate: ${mem.content.slice(0, 60)}`);
        continue;
      }
      saveMemory({
        content: mem.content,
        category: mem.category,
        agentId: null,
        source: "auto",
        sourceConversationId: input.conversationId,
        evidenceQuote: mem.evidence,
        evidenceMessageId: input.messageId,
        supersedesId: mem.supersedes ?? undefined,
      });
      console.log(`[memory-extractor] Saved: [${mem.category}] ${mem.content}${mem.supersedes ? ` (replaces ${mem.supersedes})` : ""}`);
    }
  } catch (err) {
    console.warn("[memory-extractor] Extraction failed:", err instanceof Error ? err.message : err);
  }
}
