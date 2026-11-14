/**
 * Shared Spotify API helper — handles OAuth token retrieval, authorization, and errors.
 */

export class SpotifyNotConnectedError extends Error {
  constructor() {
    super("Spotify is not connected. The user needs to connect Spotify in Settings.");
    this.name = "SpotifyNotConnectedError";
  }
}

export async function spotifyFetch(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { getAccessToken } = await import("../../integrations/spotify/auth.js");
  const token = await getAccessToken();
  if (!token) throw new SpotifyNotConnectedError();

  const { timeoutMs, ...fetchOptions } = options ?? {};
  const res = await fetch(url, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...fetchOptions.headers,
    },
    signal: AbortSignal.timeout(timeoutMs ?? 15_000),
  });

  if (res.status === 401) {
    throw new Error("Spotify token expired or revoked. Please reconnect Spotify in Settings.");
  }

  return res;
}
