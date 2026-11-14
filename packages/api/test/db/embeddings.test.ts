import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { settings } from "../../src/db/schema.js";
import { embeddingModelId, generateEmbedding } from "../../src/db/embeddings.js";

const realFetch = globalThis.fetch;
const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

function pick(value: string | null) {
  db.delete(settings).where(eq(settings.key, "embedding_model")).run();
  if (value) db.insert(settings).values({ key: "embedding_model", value }).run();
}

beforeEach(() => {
  requests.length = 0;
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("GEMINI_API_KEY", "g-test");
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const body = url.includes("openai") ? { data: [{ embedding: [0.1, 0.2] }] } : { embedding: { values: [0.3, 0.4, 0.5] } };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  pick(null);
});

test("Ollama keeps the bare model name, so vectors stored before other providers still match", () => {
  pick(null);
  expect(embeddingModelId()).toBe("nomic-embed-text");
  pick("ollama:mxbai-embed-large");
  expect(embeddingModelId()).toBe("mxbai-embed-large");
});

test("OpenAI and Gemini embed with the stored key, and carry the provider in the id", async () => {
  pick("openai:text-embedding-3-small");
  expect(embeddingModelId()).toBe("openai:text-embedding-3-small");
  expect(await generateEmbedding("hi")).toEqual([0.1, 0.2]);
  expect(requests[0]).toMatchObject({ url: "https://api.openai.com/v1/embeddings", body: { model: "text-embedding-3-small", input: "hi" } });
  expect(requests[0].headers.Authorization).toBe("Bearer sk-test");

  pick("gemini:gemini-embedding-001");
  expect(await generateEmbedding("hi")).toEqual([0.3, 0.4, 0.5]);
  expect(requests[1].url).toContain("/models/gemini-embedding-001:embedContent");
  expect(requests[1].headers["x-goog-api-key"]).toBe("g-test");
});

test("a provider without a key fails instead of sending an empty key", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  pick("openai:text-embedding-3-small");
  await expect(generateEmbedding("hi")).rejects.toThrow(/OPENAI_API_KEY/);
  expect(requests).toHaveLength(0);
});
