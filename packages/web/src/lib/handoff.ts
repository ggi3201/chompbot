import type { AgentModelOption, AgentProvider, AgentProviderModels, AgentSelection } from "@chomp/shared";

export const HANDOFF_COMMAND = "/handoff";

export interface HandoffRequest {
  /** What the new chat runs on: the words after /handoff, laid over the current choice. */
  target: Partial<AgentSelection>;
  /** The rest: the new chat's task, if one was given. */
  goal: string;
}

const PROVIDERS: AgentProvider[] = ["claude", "codex"];

function words(value: string): string[] {
  return value.toLowerCase().split(/[\s._-]+/).filter(Boolean);
}

/** "Sonnet 5.5", "sonnet-5-5" and "sonnet5.5" are one name. */
function squash(value: string): string {
  return words(value).join("");
}

interface Match {
  provider: AgentProvider;
  model: AgentModelOption;
  length: number;
}

/**
 * The model the leading words name. A full name ("sonnet 5.5", "gpt-6-luna")
 * wins over a short one ("sonnet", "luna"), which takes the first model, in
 * the server's order, whose name contains every word.
 */
function matchModel(tokens: string[], providers: AgentProviderModels[]): Match | undefined {
  const models = providers.flatMap((p) => p.models.map((model) => ({ provider: p.provider, model })));
  for (const exact of [true, false]) {
    for (let length = Math.min(tokens.length, 4); length >= 1; length--) {
      const phrase = tokens.slice(0, length).join(" ");
      const found = models.find(({ model }) => {
        if (exact) return squash(model.label) === squash(phrase) || squash(model.id) === squash(phrase);
        const names = new Set([...words(model.label), ...words(model.id)]);
        return words(phrase).every((word) => names.has(word));
      });
      if (found) return { ...found, length };
    }
  }
  return undefined;
}

/**
 * `/handoff [claude|codex] [model] [effort] [fast] [task…]`. Only the leading
 * words count as settings, so a task that mentions a model stays the task.
 * Null when the text is not a handoff.
 */
export function parseHandoff(
  text: string,
  providers: AgentProviderModels[],
  current: AgentSelection | undefined,
): HandoffRequest | null {
  const trimmed = text.trim();
  if (trimmed !== HANDOFF_COMMAND && !trimmed.startsWith(`${HANDOFF_COMMAND} `)) return null;
  const tokens = trimmed.slice(HANDOFF_COMMAND.length).trim().split(/\s+/).filter(Boolean);
  const available = providers.filter((p) => p.available && p.models.length > 0);
  const target: Partial<AgentSelection> = { ...current };

  const named = PROVIDERS.find((p) => p === tokens[0]?.toLowerCase());
  if (named) {
    tokens.shift();
    if (named !== current?.provider) {
      target.provider = named;
      delete target.model;
      delete target.effort;
    }
  }

  const match = matchModel(tokens, named ? available.filter((p) => p.provider === named) : available);
  if (match) {
    tokens.splice(0, match.length);
    target.provider = match.provider;
    target.model = match.model.id;
    if (match.model.id !== current?.model) delete target.effort;
  }
  // The model an effort word is checked against: the named one, the current one, or the engine's default.
  const engineModels = available.find((p) => p.provider === target.provider)?.models ?? [];
  const model = engineModels.find((m) => m.id === target.model) ?? engineModels.find((m) => m.featured) ?? engineModels[0];

  while (tokens.length > 0) {
    const word = tokens[0].toLowerCase();
    if (word === "fast") target.fast = true;
    else if (model?.efforts.includes(word)) target.effort = word;
    else break;
    tokens.shift();
  }

  return { target, goal: tokens.join(" ") };
}
