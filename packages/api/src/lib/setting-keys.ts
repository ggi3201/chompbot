// Shared allow-list of setting keys that may be read or written through
// public surfaces (settings REST routes + MCP get_setting tool).
//
// Anything outside this list is internal state managed elsewhere (auth, sync,
// agent runtime) and must not be exposed for free-form mutation.

/** Saved as JSON: which agent, provider and model runs by default, overall and per channel. */
const RUN_TARGET_KEYS = ["run_target", "run_target_discord", "run_target_telegram"];

export const SAFE_SETTING_KEYS: readonly string[] = [
  "ollama_model",
  "notification_prefs",
  "domain",
  // Monitoring alerts bot: the chat alerts go to, and the one Telegram user whose Diagnose taps are answered.
  "telegram_alerts_chat_id",
  "telegram_alerts_owner_id",
  // Chomp's own small jobs: {provider: claude|codex, model} on that runtime's login.
  "background_model",
  // Memory search vectors: "<ollama|openai|gemini>:<model>".
  "embedding_model",
  "drive_folder_id",
  "github_issue_repos",
  "github_username",
  "agent_soul",
  "user_profile_md",
  ...RUN_TARGET_KEYS,
  // Agent guardrails (numeric)
  "max_concurrent_agents",
  "max_output_bytes",
  "agent_idle_timeout_ms",
  "circuit_breaker_window_ms",
  "circuit_breaker_failures",
  "circuit_breaker_cooldown_ms",
  "max_dispatches_per_hour",
  // Voice
  "voice_tts_voice",
  "voice_auto_speak",
  // Backups
  "backup_retention_days",
] as const;

/** Numeric guardrail bounds for setting keys that accept only positive integers. */
export const SETTING_GUARDRAIL_BOUNDS: Record<string, { min: number; max: number }> = {
  max_concurrent_agents: { min: 1, max: 10 },
  max_output_bytes: { min: 512 * 1024, max: 50 * 1024 * 1024 },
  agent_idle_timeout_ms: { min: 60_000, max: 120 * 60_000 },
  circuit_breaker_window_ms: { min: 60_000, max: 120 * 60_000 },
  circuit_breaker_failures: { min: 1, max: 50 },
  circuit_breaker_cooldown_ms: { min: 60_000, max: 120 * 60_000 },
  max_dispatches_per_hour: { min: 1, max: 50 },
};

export function isSafeSettingKey(key: string): boolean {
  return SAFE_SETTING_KEYS.includes(key);
}

/**
 * Validate a setting key + value pair. Returns null if valid, an error string
 * otherwise. Numeric guardrail bounds are enforced.
 */
export function validateSettingValue(key: string, value: unknown): string | null {
  if (!isSafeSettingKey(key)) {
    return `Invalid setting key: ${key}. Allowed: ${SAFE_SETTING_KEYS.join(", ")}`;
  }
  if (RUN_TARGET_KEYS.includes(key)) return runTargetError(key, value);
  if (key === "background_model") return backgroundModelError(value);
  if (key === "embedding_model") return embeddingModelError(value);
  const bounds = SETTING_GUARDRAIL_BOUNDS[key];
  if (!bounds) return null;
  const num = Number(value);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return `${key} must be a number`;
  }
  if (num < bounds.min || num > bounds.max) {
    return `${key} must be between ${bounds.min} and ${bounds.max}`;
  }
  return null;
}

function runTargetError(key: string, value: unknown): string | null {
  if (value === "") return null;
  try {
    const target = JSON.parse(String(value)) as Record<string, unknown>;
    const validProvider = target.provider === undefined || target.provider === "claude" || target.provider === "codex";
    const validStrings = ["soulId", "model", "effort"].every((field) => target[field] === undefined || typeof target[field] === "string");
    if (target && validProvider && validStrings) return null;
  } catch {
    // Falls through to the error below.
  }
  return `${key} must be JSON with provider (claude or codex), soulId, model and effort`;
}

function backgroundModelError(value: unknown): string | null {
  if (value === "") return null;
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    if ((parsed.provider === "claude" || parsed.provider === "codex") && typeof parsed.model === "string" && parsed.model) return null;
  } catch {
    // Falls through to the error below.
  }
  return "background_model must be JSON with provider (claude or codex) and model";
}

function embeddingModelError(value: unknown): string | null {
  if (value === "" || /^(ollama|openai|gemini):[\w.:/-]+$/.test(String(value))) return null;
  return "embedding_model must look like ollama:<model>, openai:<model> or gemini:<model>";
}
