import { useCallback, useState } from "react";

const DRAFT_PREFIX = "chomp:draft:";

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Quota or private mode: the draft still holds until the page goes.
  }
}

/** Starts a conversation's composer with this text, for a page that hands off to the chat. */
export function setConversationDraft(conversationId: string, text: string) {
  writeDraft(DRAFT_PREFIX + conversationId, text);
}

/**
 * The composer text, one draft per conversation (and one for a new chat),
 * kept in localStorage so a reload or a switch to another chat and back does
 * not lose what was being written. Sending clears it like any other edit.
 */
export function useDraft(conversationId: string | undefined) {
  const key = DRAFT_PREFIX + (conversationId ?? "new");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = drafts[key] ?? readDraft(key);

  const setInput = useCallback((next: string | ((previous: string) => string)) => {
    setDrafts((prev) => {
      const value = typeof next === "function" ? next(prev[key] ?? readDraft(key)) : next;
      writeDraft(key, value);
      return { ...prev, [key]: value };
    });
  }, [key]);

  /** Write another chat's draft; a handoff leaves its note in the new chat's composer. */
  const setDraftFor = useCallback((conversationId: string | undefined, value: string) => {
    const target = DRAFT_PREFIX + (conversationId ?? "new");
    writeDraft(target, value);
    setDrafts((prev) => ({ ...prev, [target]: value }));
  }, []);

  return [input, setInput, setDraftFor] as const;
}
