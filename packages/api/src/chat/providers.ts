import { getSecret } from "../lib/secrets.js";

/** Providers whose API keys Chomp keeps in its key store (Settings → API keys). */
export type KeyProvider = "openai" | "gemini" | "anthropic" | "kimi" | "deepseek";

/** Provider name → env var / secret key name (single source of truth) */
export const PROVIDER_SECRET_KEYS: Record<KeyProvider, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  kimi: "KIMI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Look up API key: encrypted secrets -> env vars -> undefined */
export function getApiKey(provider: KeyProvider): string | undefined {
  const envKey = PROVIDER_SECRET_KEYS[provider];
  return getSecret(envKey) ?? process.env[envKey];
}
