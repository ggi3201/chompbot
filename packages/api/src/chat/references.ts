import { like } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";

const REFERENCE = /@session:([0-9a-f]{8})\b/g;

/** A chat by its full id or its first 8 characters, as `@session:` references carry. */
export function findChat(id: string): { id: string; title: string | null } | undefined {
  // Hex and dashes only, so a caller can never smuggle LIKE wildcards in.
  if (!/^[0-9a-f-]{8,36}$/.test(id)) return undefined;
  return db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(like(conversations.id, `${id}%`)).get();
}

/** Spells out each `@session:<id8>` the user wrote: which chat it is, and how the agent reaches it. */
export function withChatReferences(text: string): string {
  const ids = [...new Set([...text.matchAll(REFERENCE)].map((match) => match[1]))];
  const notes = ids.flatMap((id) => {
    const chat = findChat(id);
    return chat ? [`@session:${id} is the chat "${chat.title ?? "Untitled"}" (conversation id ${chat.id}). Read it with get_conversation_messages; message its agent with message_chat.`] : [];
  });
  return notes.length > 0 ? `${text}\n\n[${notes.join("\n")}]` : text;
}
