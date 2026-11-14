import { useEffect, useRef, useState } from "react";
import type { AgentProviderModels, AgentSelection } from "@chomp/shared";
import { apiFetch } from "../lib/api";
import { readLastUsedSelection, readStoredSelection, resolveSelection, writeConversationSelection, writeStoredSelection } from "../lib/agent-selection";

/** The providers and models the composer can pick from. */
export function useAgentModels(): AgentProviderModels[] {
  const [providers, setProviders] = useState<AgentProviderModels[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/chat/agent-models")
      .then((res) => (res.ok ? res.json() as Promise<AgentProviderModels[]> : []))
      .then((data) => {
        if (!cancelled) setProviders(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}

/**
 * The composer's model choice, one per conversation. A chat without a stored
 * choice gets its own: a new chat keeps the one it was started with once it
 * has an id, and an older chat takes what it last ran with (engine, model,
 * soul). Always resolved against what the server offers now.
 */
export function useAgentSelection(conversationId: string | undefined, providers: AgentProviderModels[]) {
  // Choices made or derived in this session; localStorage covers the rest.
  const [chosen, setChosen] = useState<Record<string, Partial<AgentSelection>>>({});
  const key = conversationId ?? "";
  const newChatChoice = chosen[""] ?? readLastUsedSelection();
  // Until a chat's own choice is known, show the new-chat one rather than nothing.
  const selection = resolveSelection(providers, chosen[key] ?? readStoredSelection(conversationId) ?? newChatChoice);

  // Syncs localStorage and the server's record of the chat, both external.
  const previousId = useRef(conversationId);
  useEffect(() => {
    const cameFrom = previousId.current;
    previousId.current = conversationId;
    if (!conversationId || readStoredSelection(conversationId)) return;
    const keep = (value: Partial<AgentSelection>) => {
      writeConversationSelection(conversationId, value);
      setChosen((prev) => ({ ...prev, [conversationId]: value }));
    };
    if (cameFrom === undefined && newChatChoice) {
      // The new chat just got its id: it keeps what it was started with.
      keep(newChatChoice);
      return;
    }
    let cancelled = false;
    apiFetch(`/conversations/${conversationId}/last-selection`)
      .then((res): Promise<Partial<AgentSelection>> | Partial<AgentSelection> => (res.ok ? res.json() : {}))
      .then((ranWith) => {
        if (!cancelled) keep(ranWith.provider ? ranWith : newChatChoice ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  function select(next: AgentSelection) {
    writeStoredSelection(conversationId, next);
    setChosen((prev) => ({ ...prev, [key]: next }));
  }

  /** The choice a new chat starts with, set from wherever the page is now. */
  function selectForNewChat(next: Partial<AgentSelection>) {
    const resolved = resolveSelection(providers, next);
    if (!resolved) return;
    writeStoredSelection(undefined, resolved);
    setChosen((prev) => ({ ...prev, "": resolved }));
  }

  return { selection, select, selectForNewChat };
}
