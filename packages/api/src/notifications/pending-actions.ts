/**
 * Short-lived registry of "action prompts" that clients can trigger by ID.
 *
 * Used so Telegram callback_data (64-byte limit) can carry a reference rather
 * than the full prompt text. The resolver looks up the stored prompt and the
 * conversation it belongs to, then the caller decides what to do with it
 * (usually: inject into the chat pipeline).
 */
import { randomBytes } from "crypto";

export interface PendingAction {
  prompt: string;
  conversationId?: string;
}

interface Entry extends PendingAction {
  expiresAt: number;
}

const actions = new Map<string, Entry>();
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 200;

function sweep() {
  const now = Date.now();
  for (const [id, entry] of actions) {
    if (entry.expiresAt < now) actions.delete(id);
  }
}

/** Register an actionable prompt, returning an opaque id for callback_data. */
export function createPendingAction(prompt: string, conversationId?: string): string {
  sweep();
  if (actions.size >= MAX_ENTRIES) {
    // Drop the oldest to cap memory
    const oldest = actions.keys().next().value;
    if (oldest) actions.delete(oldest);
  }
  const id = randomBytes(5).toString("hex"); // 10 chars → fits with "action:" prefix in 64 bytes
  actions.set(id, { prompt, conversationId, expiresAt: Date.now() + TTL_MS });
  return id;
}

/** Look up and consume an action by id. Returns null if missing or expired. */
export function resolvePendingAction(id: string): PendingAction | null {
  const entry = actions.get(id);
  if (!entry) return null;
  actions.delete(id);
  if (entry.expiresAt < Date.now()) return null;
  return { prompt: entry.prompt, conversationId: entry.conversationId };
}
