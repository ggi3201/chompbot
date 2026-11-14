/**
 * Embeddings for memory search: Ollama locally, or OpenAI / Gemini with a key from the key store.
 * Provides cosine similarity and semantic search over memory records.
 */
import { eq } from "drizzle-orm";
import { ollama } from "../ollama/client.js";
import { getApiKey } from "../chat/providers.js";
import { db } from "./index.js";
import { settings } from "./schema.js";

type EmbeddingProvider = "ollama" | "openai" | "gemini";
const DEFAULT_OLLAMA_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";

function choice(): { provider: EmbeddingProvider; model: string } {
  const saved = db.select().from(settings).where(eq(settings.key, "embedding_model")).get()?.value;
  const match = saved?.match(/^(ollama|openai|gemini):(.+)$/);
  return match ? { provider: match[1] as EmbeddingProvider, model: match[2] } : { provider: "ollama", model: DEFAULT_OLLAMA_MODEL };
}

/**
 * The id stored next to each vector, so a model change re-embeds only what it must.
 * Ollama models keep their bare name, as they were stored before other providers existed.
 */
export function embeddingModelId(): string {
  const { provider, model } = choice();
  return provider === "ollama" ? model : `${provider}:${model}`;
}

/** Generate an embedding vector for the given text */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { provider, model } = choice();
  if (provider === "ollama") return (await ollama.embed({ model, input: text })).embeddings[0];
  const key = getApiKey(provider);
  if (!key) throw new Error(`No ${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} in the key store`);
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) throw new Error(`openai embeddings answered ${res.status}`);
    return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data[0].embedding;
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) throw new Error(`gemini embeddings answered ${res.status}`);
  return ((await res.json()) as { embedding: { values: number[] } }).embedding.values;
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

/** Semantic search: rank candidates by similarity to query embedding */
export function semanticSearch<T>(
  queryEmbedding: number[],
  candidates: Array<{ item: T; embedding: number[] }>,
  topK: number = 10,
  threshold: number = 0.3,
): ScoredItem<T>[] {
  const scored = candidates
    .map(({ item, embedding }) => ({
      item,
      score: cosineSimilarity(queryEmbedding, embedding),
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

/** Check if the embedding model is available: Ollama has it pulled, or the provider's key is stored. */
export async function isEmbeddingModelReady(): Promise<boolean> {
  const { provider, model } = choice();
  if (provider !== "ollama") return Boolean(getApiKey(provider));
  try {
    await ollama.show({ model });
    return true;
  } catch {
    return false;
  }
}
