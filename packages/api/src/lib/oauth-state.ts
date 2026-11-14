import { randomBytes } from "crypto";

// shortcut: kept in memory, so a Chomp restart between starting a login and finishing it means starting again; store them if that ever bites.
const pending = new Map<string, { origin: string; expires: number }>();
const TTL_MS = 10 * 60_000;

/** A one-time OAuth `state` that remembers where to send the browser afterwards. Only this Chomp can issue one. */
export function issueOAuthState(origin: string, now = Date.now()): string {
  for (const [key, entry] of pending) if (entry.expires < now) pending.delete(key);
  const state = randomBytes(24).toString("base64url");
  pending.set(state, { origin, expires: now + TTL_MS });
  return state;
}

/** The origin a valid state was issued for, once; null for a state this Chomp did not issue, reused or expired. */
export function takeOAuthState(state: unknown, now = Date.now()): string | null {
  if (typeof state !== "string") return null;
  const entry = pending.get(state);
  pending.delete(state);
  return entry && entry.expires >= now ? entry.origin : null;
}
