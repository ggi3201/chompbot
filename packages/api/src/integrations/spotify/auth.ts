/**
 * Spotify OAuth2 integration for music + podcast access.
 * Tokens are stored encrypted in the settings table via secrets.
 */
import { saveSecret, getSecret, deleteSecret } from "../../lib/secrets.js";

// Forward-compatible scope set: includes everything we'll need for playlists
// and playback in upcoming PRs so the user only consents once.
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-top-read",
  "user-read-recently-played",
];

function getClientId(): string {
  return getSecret("SPOTIFY_CLIENT_ID") ?? process.env.SPOTIFY_CLIENT_ID ?? "";
}

function getClientSecret(): string {
  return getSecret("SPOTIFY_CLIENT_SECRET") ?? process.env.SPOTIFY_CLIENT_SECRET ?? "";
}

function getRedirectUri(): string {
  const domain = process.env.CHOMP_DOMAIN ?? `http://localhost:${process.env.PORT ?? "3001"}`;
  return `${domain}/api/spotify/callback`;
}

function basicAuthHeader(): string {
  const creds = `${getClientId()}:${getClientSecret()}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

/** The OAuth consent URL. `state` comes from issueOAuthState, so the callback can check the login started here. */
export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    show_dialog: "false",
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

/** Exchange authorization code for tokens */
export async function handleCallback(code: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({
        code,
        redirect_uri: getRedirectUri(),
        grant_type: "authorization_code",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error_description ?? err.error ?? "Token exchange failed" };
    }

    const tokens = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
      scope: string;
    };

    saveSecret("SPOTIFY_ACCESS_TOKEN", tokens.access_token);
    if (tokens.refresh_token) {
      saveSecret("SPOTIFY_REFRESH_TOKEN", tokens.refresh_token);
    }
    saveSecret("SPOTIFY_TOKEN_EXPIRY", String(Date.now() + tokens.expires_in * 1000));

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Get a fresh access token, auto-refreshing if expired */
export async function getAccessToken(): Promise<string | null> {
  const token = getSecret("SPOTIFY_ACCESS_TOKEN");
  const expiry = getSecret("SPOTIFY_TOKEN_EXPIRY");
  const refreshToken = getSecret("SPOTIFY_REFRESH_TOKEN");

  if (!token) return null;

  // Check if token is expired (with 5-minute buffer)
  if (expiry && Date.now() > parseInt(expiry, 10) - 300000) {
    if (!refreshToken) return null;

    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basicAuthHeader(),
        },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!res.ok) return null;

      const data = await res.json() as { access_token: string; expires_in: number; refresh_token?: string };
      saveSecret("SPOTIFY_ACCESS_TOKEN", data.access_token);
      saveSecret("SPOTIFY_TOKEN_EXPIRY", String(Date.now() + data.expires_in * 1000));
      // Spotify may rotate refresh tokens; persist the new one when present.
      if (data.refresh_token) {
        saveSecret("SPOTIFY_REFRESH_TOKEN", data.refresh_token);
      }
      return data.access_token;
    } catch {
      return null;
    }
  }

  return token;
}

/** Check if Spotify is connected */
export function isConnected(): boolean {
  return getSecret("SPOTIFY_ACCESS_TOKEN") !== null;
}

/** Disconnect Spotify (remove all tokens) */
export function disconnect(): void {
  deleteSecret("SPOTIFY_ACCESS_TOKEN");
  deleteSecret("SPOTIFY_REFRESH_TOKEN");
  deleteSecret("SPOTIFY_TOKEN_EXPIRY");
}
