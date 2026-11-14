/**
 * Recipe tools — search and import recipes via the Chewable Foodie agent API.
 *
 * Requires CHEWABLE_API_URL and CHEWABLE_API_KEY in settings (encrypted).
 */

import { getSecret } from "../../lib/secrets.js";

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = getSecret("foodie_api_url");
  const apiKey = getSecret("foodie_api_key");
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Chewable Foodie is not configured. Set foodie_api_url and foodie_api_key in Settings.",
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function chewableFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const { baseUrl, apiKey } = getConfig();
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...options?.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
}

// ── Search Recipes ─────────────────────────────────────────

interface AgentRecipeResult {
  id: string;
  name: string;
  author: string | null;
  url: string | null;
  imageUrl: string | null;
  cuisine: string | null;
  type: string | null;
  createdAt: string;
}

interface AgentSearchResponse {
  results: AgentRecipeResult[];
}

export async function execSearchRecipes(
  query?: string,
  url?: string,
  limit?: number,
): Promise<string> {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (url) params.set("url", url);
  if (limit) params.set("limit", String(limit));

  if (!query && !url) {
    return "ERROR: Provide either a search query or a URL to look up.";
  }

  const res = await chewableFetch(`/api/agent/recipes/search?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `ERROR: Recipe search failed (${res.status}): ${body.slice(0, 200)}`;
  }

  const data = (await res.json()) as AgentSearchResponse;
  if (!data.results || data.results.length === 0) {
    return `No recipes found${query ? ` for "${query}"` : ""}.`;
  }

  const lines = data.results.map((r) => {
    const parts = [`Name: ${r.name}`, `ID: ${r.id}`];
    if (r.author) parts.push(`Author: ${r.author}`);
    if (r.cuisine && r.cuisine !== "None") parts.push(`Cuisine: ${r.cuisine}`);
    if (r.type && r.type !== "None") parts.push(`Type: ${r.type}`);
    if (r.url) parts.push(`URL: ${r.url}`);
    return parts.join("\n  ");
  });

  return `Found ${data.results.length} recipe(s):\n\n${lines.join("\n\n")}`;
}

// ── Import Recipe from URL ─────────────────────────────────

interface AgentImportResponse {
  success: boolean;
  recipeId: string;
  name: string | null;
  imageUrl: string | null;
  error: string | null;
}

export async function execImportRecipeFromUrl(
  recipeUrl: string,
  isGlobal?: boolean,
  sourceTag?: string,
): Promise<string> {
  const res = await chewableFetch("/api/agent/import/url", {
    method: "POST",
    body: JSON.stringify({
      url: recipeUrl,
      isGlobal: isGlobal ?? true,
      sourceTag: sourceTag ?? "chomp",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `ERROR: Recipe import failed (${res.status}): ${body.slice(0, 200)}`;
  }

  const data = (await res.json()) as AgentImportResponse;
  if (!data.success) {
    return `ERROR: Import failed: ${data.error ?? "unknown error"}`;
  }

  return `Recipe imported: "${data.name ?? "Unknown"}" (ID: ${data.recipeId})`;
}

// ── Update Recipe Image ────────────────────────────────────

interface UpdateImageResponse {
  imageUrl: string;
}

export async function execUpdateRecipeImage(
  recipeId: string,
  imageUrl: string,
): Promise<string> {
  // Download the image from the provided URL
  let imageBuffer: ArrayBuffer;
  try {
    const imageRes = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Chomp/1.0)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!imageRes.ok) {
      return `ERROR: Failed to download image (${imageRes.status}) from ${imageUrl}`;
    }
    imageBuffer = await imageRes.arrayBuffer();
  } catch (e) {
    return `ERROR: Could not fetch image URL: ${(e as Error).message}`;
  }

  const base64 = Buffer.from(imageBuffer).toString("base64");

  const res = await chewableFetch(`/api/agent/recipe/${recipeId}/image`, {
    method: "POST",
    body: JSON.stringify({ Image: base64 }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `ERROR: Image upload failed (${res.status}): ${body.slice(0, 200)}`;
  }

  const data = (await res.json()) as UpdateImageResponse;
  return `Recipe image updated: ${data.imageUrl}`;
}

// ── Import Recipe from Text ────────────────────────────────

export async function execImportRecipeFromText(
  text: string,
  sourceUrl?: string,
  isGlobal?: boolean,
  sourceTag?: string,
): Promise<string> {
  const res = await chewableFetch("/api/agent/import/text", {
    method: "POST",
    body: JSON.stringify({
      text,
      sourceUrl,
      isGlobal: isGlobal ?? true,
      sourceTag: sourceTag ?? "chomp",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `ERROR: Recipe text import failed (${res.status}): ${body.slice(0, 200)}`;
  }

  const data = (await res.json()) as AgentImportResponse;
  if (!data.success) {
    return `ERROR: Import failed: ${data.error ?? "unknown error"}`;
  }

  return `Recipe imported from text: "${data.name ?? "Unknown"}" (ID: ${data.recipeId})`;
}
