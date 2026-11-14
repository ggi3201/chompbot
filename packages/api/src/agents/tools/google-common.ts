/**
 * Shared Google API helper — handles OAuth token retrieval, authorization, and errors.
 */

export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google is not connected. The user needs to connect Google in Settings.");
    this.name = "GoogleNotConnectedError";
  }
}

export async function googleFetch(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { getAccessToken } = await import("../../integrations/google/auth.js");
  const token = await getAccessToken();
  if (!token) throw new GoogleNotConnectedError();

  const { timeoutMs, ...fetchOptions } = options ?? {};
  const res = await fetch(url, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Callers can override Content-Type (e.g. multipart uploads) via options.headers
      ...fetchOptions.headers,
    },
    signal: AbortSignal.timeout(timeoutMs ?? 15_000),
  });

  if (res.status === 401) {
    throw new Error("Google token expired or revoked. Please reconnect Google in Settings.");
  }

  return res;
}
