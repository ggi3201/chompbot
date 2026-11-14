import { eq } from "drizzle-orm";
import { ACCESS_MODES, CLI_AGENT_DEFAULT_MODEL, type AccessMode, type AgentProvider, type RunTarget } from "@chomp/shared";
import type { DeliveryChannel } from "../channels/response-format.js";
import { db } from "../db/index.js";
import { settings, souls } from "../db/schema.js";

export const PROVIDER_LABELS: Record<AgentProvider, string> = { claude: "Claude", codex: "Codex" };

export const PROVIDER_AGENT_TYPES = { claude: "claude-sdk", codex: "codex-sdk" } as const;

/** Names and @mentions that mean a provider, not an agent. */
export const PROVIDER_ALIASES: Record<AgentProvider, string[]> = {
  claude: ["claude code", "claude", "cc"],
  codex: ["codex"],
};

/** The run a turn ends up with: a provider and model are always known; no soulId means the default soul. */
export type ResolvedRun = RunTarget & { provider: AgentProvider; model: string };

// shortcut: tells providers apart by the model id's prefix, extend it when a third provider arrives.
export function providerOfModel(model: string | undefined): AgentProvider | undefined {
  if (!model) return undefined;
  return model.startsWith("gpt-") ? "codex" : "claude";
}

/**
 * Who runs a turn. `mention` is what the message itself asked for, `chosen` the
 * caller's explicit choice and `base` what it falls back on. The soul is
 * and access are independent of the rest. A model and effort belong to their
 * provider, so they only carry over while the provider stays the same.
 */
export function resolveRun(
  mention: Pick<RunTarget, "provider" | "soulId">,
  chosen: RunTarget,
  base: RunTarget,
): ResolvedRun {
  const chosenProvider = chosen.provider ?? providerOfModel(chosen.model) ?? base.provider ?? "claude";
  const provider = mention.provider ?? chosenProvider;
  const picked = provider === chosenProvider ? chosen : {};
  const inherited = provider === base.provider ? base : {};
  const effort = picked.effort || inherited.effort;
  const soulId = mention.soulId ?? chosen.soulId ?? base.soulId;
  const access = chosen.access ?? base.access;
  return {
    provider,
    model: picked.model || inherited.model || CLI_AGENT_DEFAULT_MODEL[PROVIDER_AGENT_TYPES[provider]],
    ...(effort ? { effort } : {}),
    ...(soulId ? { soulId } : {}),
    ...(access ? { access } : {}),
  };
}

/** A soul by name, case-insensitive. */
export function findSoulByName(name: string): typeof souls.$inferSelect | undefined {
  const wanted = name.trim().toLowerCase();
  return db.select().from(souls).all().find((s) => s.name.toLowerCase() === wanted);
}

/** A name instead of a target, as older callers and skills still send: a soul or a provider. */
export function targetFromName(name: string): RunTarget | undefined {
  const soul = findSoulByName(name);
  if (soul) return { soulId: soul.id };
  const wanted = name.trim().toLowerCase();
  const provider = (Object.keys(PROVIDER_ALIASES) as AgentProvider[]).find((p) => PROVIDER_ALIASES[p].includes(wanted));
  return provider ? { provider } : undefined;
}

/** The target saved on a rule, trigger, widget or schedule. Saved configs are free-form JSON, so only well-typed fields count. */
export function runTargetFrom(config: Record<string, unknown>): RunTarget {
  const text = (key: string) => (typeof config[key] === "string" && config[key] ? (config[key] as string) : undefined);
  const provider = config.provider === "claude" || config.provider === "codex" ? config.provider : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(text("model") ? { model: text("model") } : {}),
    ...(text("effort") ? { effort: text("effort") } : {}),
    ...(text("soulId") ? { soulId: text("soulId") } : {}),
    ...(ACCESS_MODES.includes(config.access as AccessMode) ? { access: config.access as AccessMode } : {}),
  };
}

function setting(key: string): string {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value.trim() ?? "";
}

const SAVED_TARGET_KEYS = { default: "run_target", discord: "run_target_discord", telegram: "run_target_telegram" } as const;

export type SavedTargetName = keyof typeof SAVED_TARGET_KEYS;

export function savedTarget(name: SavedTargetName): RunTarget {
  const saved = setting(SAVED_TARGET_KEYS[name]);
  return saved ? (JSON.parse(saved) as RunTarget) : {};
}

/** What runs when nothing more specific is asked for on this channel. */
export function channelTarget(channel?: DeliveryChannel): ResolvedRun {
  const overall = savedTarget("default");
  const own = channel === "discord" || channel === "telegram" ? savedTarget(channel) : {};
  return resolveRun({}, own, overall);
}

/** The channel default in words, for /status. */
export function channelTargetLabel(channel: DeliveryChannel): string {
  const { provider, model, soulId } = channelTarget(channel);
  const soul = soulId
    ? db.select().from(souls).where(eq(souls.id, soulId)).get()
    : db.select().from(souls).where(eq(souls.isDefault, true)).get();
  return `${soul?.name ?? "No agent"} on ${PROVIDER_LABELS[provider]} ${model}`;
}
