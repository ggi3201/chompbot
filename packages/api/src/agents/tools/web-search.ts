/**
 * SearXNG web search tool — federated search across DuckDuckGo, Google, Startpage, Brave, Wikipedia.
 */

import { getSecret } from "../../lib/secrets.js";

const DEFAULT_SEARXNG_URL = "http://localhost:8080";
const MAX_RESULTS = 8;

interface SearXNGResult {
  title: string;
  url: string;
  content: string;  // snippet
}

interface SearXNGResponse {
  results: SearXNGResult[];
  query: string;
}

export async function execWebSearch(query: string, category?: string): Promise<string> {
  const baseUrl = getSecret("SEARXNG_URL") ?? process.env.SEARXNG_URL ?? DEFAULT_SEARXNG_URL;

  const params = new URLSearchParams({
    q: query,
    format: "json",
  });
  if (category) params.set("categories", category);

  const url = `${baseUrl}/search?${params.toString()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!res.ok) {
      return `ERROR: SearXNG returned ${res.status}: ${await res.text().catch(() => "unknown error")}`;
    }

    const data = await res.json() as SearXNGResponse;
    const results = data.results?.slice(0, MAX_RESULTS);

    if (!results || results.length === 0) {
      return `No results found for "${query}".`;
    }

    return results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || "(no snippet)"}`
    ).join("\n\n");
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return "ERROR: Web search timed out after 10s. SearXNG may be unreachable.";
    }
    return `ERROR: Web search failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}
