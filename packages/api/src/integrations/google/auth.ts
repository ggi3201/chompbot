/**
 * Google OAuth2 integration for Gmail, Calendar, and Drive access.
 * Tokens are stored encrypted in the settings table via secrets.
 */
import { saveSecret, getSecret, deleteSecret } from "../../lib/secrets.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];

function getClientId(): string {
  return getSecret("GOOGLE_CLIENT_ID") ?? process.env.GOOGLE_CLIENT_ID ?? "";
}

function getClientSecret(): string {
  return getSecret("GOOGLE_CLIENT_SECRET") ?? process.env.GOOGLE_CLIENT_SECRET ?? "";
}

function getRedirectUri(): string {
  const domain = process.env.CHOMP_DOMAIN ?? `http://localhost:${process.env.PORT ?? "3001"}`;
  return `${domain}/api/google/callback`;
}

/** The OAuth consent URL. `state` comes from issueOAuthState, so the callback can check the login started here. */
export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange authorization code for tokens */
export async function handleCallback(code: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: getClientId(),
        client_secret: getClientSecret(),
        redirect_uri: getRedirectUri(),
        grant_type: "authorization_code",
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      return { success: false, error: err.error_description ?? "Token exchange failed" };
    }

    const tokens = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    // Store tokens encrypted
    saveSecret("GOOGLE_ACCESS_TOKEN", tokens.access_token);
    if (tokens.refresh_token) {
      saveSecret("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
    }
    saveSecret("GOOGLE_TOKEN_EXPIRY", String(Date.now() + tokens.expires_in * 1000));

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Get a fresh access token, auto-refreshing if expired */
export async function getAccessToken(): Promise<string | null> {
  const token = getSecret("GOOGLE_ACCESS_TOKEN");
  const expiry = getSecret("GOOGLE_TOKEN_EXPIRY");
  const refreshToken = getSecret("GOOGLE_REFRESH_TOKEN");

  if (!token) return null;

  // Check if token is expired (with 5-minute buffer)
  if (expiry && Date.now() > parseInt(expiry, 10) - 300000) {
    if (!refreshToken) return null;

    // Refresh the token
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: getClientId(),
          client_secret: getClientSecret(),
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!res.ok) return null;

      const data = await res.json() as { access_token: string; expires_in: number };
      saveSecret("GOOGLE_ACCESS_TOKEN", data.access_token);
      saveSecret("GOOGLE_TOKEN_EXPIRY", String(Date.now() + data.expires_in * 1000));
      return data.access_token;
    } catch {
      return null;
    }
  }

  return token;
}

/** Check if Google is connected */
export function isConnected(): boolean {
  return getSecret("GOOGLE_ACCESS_TOKEN") !== null;
}

/** Disconnect Google (remove all tokens) */
export function disconnect(): void {
  deleteSecret("GOOGLE_ACCESS_TOKEN");
  deleteSecret("GOOGLE_REFRESH_TOKEN");
  deleteSecret("GOOGLE_TOKEN_EXPIRY");
}
