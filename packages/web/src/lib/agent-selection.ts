import {
  normalizeAccessMode,
  type AgentModelOption,
  type AgentProviderModels,
  type AgentSelection,
} from "@chomp/shared";

const STORAGE_PREFIX = "chomp:agent-selection:";
const LAST_USED_KEY = `${STORAGE_PREFIX}last`;

function defaultModel(provider: AgentProviderModels): AgentModelOption | undefined {
  return provider.models.find((m) => m.featured) ?? provider.models[0];
}

/**
 * Makes a stored choice fit what the server offers now: an unknown model falls
 * back to the provider's first featured one, an effort the model lacks to its
 * default, and fast mode off where the model has none. With nothing usable
 * stored, the first available provider wins.
 */
export function resolveSelection(
  providers: AgentProviderModels[],
  stored?: Partial<AgentSelection>,
): AgentSelection | undefined {
  const available = providers.filter((p) => p.available && p.models.length > 0);
  const provider = available.find((p) => p.provider === stored?.provider) ?? available[0];
  if (!provider) return undefined;

  const sameProvider = provider.provider === stored?.provider;
  const model = (sameProvider && provider.models.find((m) => m.id === stored?.model)) || defaultModel(provider);
  if (!model) return undefined;

  const keepsModel = sameProvider && model.id === stored?.model;

  const effort = keepsModel && stored?.effort && model.efforts.includes(stored.effort)
    ? stored.effort
    : model.defaultEffort;

  return {
    provider: provider.provider,
    ...(stored?.soulId ? { soulId: stored.soulId } : {}),
    model: model.id,
    ...(effort ? { effort } : {}),
    fast: model.supportsFast && !!stored?.fast,
    access: normalizeAccessMode(stored?.access),
  };
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

function read(key: string): Partial<AgentSelection> | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<AgentSelection>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A chat's own choice. A new chat (no id yet) starts from the one used last;
 * an existing chat never falls back to it — that made one chat's change move
 * every chat without a choice of its own.
 */
export function readStoredSelection(conversationId?: string): Partial<AgentSelection> | undefined {
  return conversationId ? read(STORAGE_PREFIX + conversationId) : read(LAST_USED_KEY);
}

export function readLastUsedSelection(): Partial<AgentSelection> | undefined {
  return read(LAST_USED_KEY);
}

/** Store a chat's choice without making it the seed for new chats. */
export function writeConversationSelection(conversationId: string, selection: Partial<AgentSelection>) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + conversationId, JSON.stringify(selection));
  } catch {
    // Quota or private mode: the choice still holds for this session.
  }
}

export function writeStoredSelection(conversationId: string | undefined, selection: AgentSelection) {
  try {
    const raw = JSON.stringify(selection);
    window.localStorage.setItem(LAST_USED_KEY, raw);
    if (conversationId) window.localStorage.setItem(STORAGE_PREFIX + conversationId, raw);
  } catch {
    // Quota or private mode: the choice still holds for this session.
  }
}
