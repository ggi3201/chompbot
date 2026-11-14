import { useState } from "react";
import { PROVIDER_ICONS } from "../ProviderIcons";
import { Button, Input } from "../ui";
import { SettingsPanel, SettingsSection, ValueRow } from "./SettingsSection";

export interface SecretEntry {
  key: string;
  masked: string;
}

export interface SecretKeyDefinition {
  key: string;
  label: string;
  url?: string;
  provider?: string;
  inputType?: "password" | "text";
}

export const AI_PROVIDER_KEYS: SecretKeyDefinition[] = [
  { key: "GEMINI_API_KEY", provider: "gemini", label: "Gemini", url: "https://aistudio.google.com/apikey" },
  { key: "OPENAI_API_KEY", provider: "openai", label: "OpenAI", url: "https://platform.openai.com/api-keys" },
  { key: "ANTHROPIC_API_KEY", provider: "anthropic", label: "Anthropic", url: "https://console.anthropic.com/settings/keys" },
  { key: "KIMI_API_KEY", provider: "kimi", label: "Kimi (Moonshot)", url: "https://platform.moonshot.ai" },
  { key: "DEEPSEEK_API_KEY", provider: "deepseek", label: "DeepSeek", url: "https://platform.deepseek.com/api_keys" },
];

export const DATA_SOURCE_KEYS: SecretKeyDefinition[] = [
  { key: "FINNHUB_API_KEY", label: "Finnhub (stocks)", url: "https://finnhub.io" },
  { key: "NEWSAPI_KEY", label: "NewsAPI", url: "https://newsapi.org" },
  { key: "FOOTBALL_DATA_KEY", label: "Football Data", url: "https://www.football-data.org" },
  { key: "HOMEASSISTANT_URL", label: "Home Assistant URL", inputType: "text" },
  { key: "HOMEASSISTANT_TOKEN", label: "Home Assistant token" },
  { key: "IMESSAGE_MAC_URL", label: "iMessage Mac URL", inputType: "text" },
  { key: "IMESSAGE_SEND_TOKEN", label: "iMessage send token" },
  { key: "SHORTCUT_SIGNER_URL", label: "Shortcut signer URL", inputType: "text" },
  { key: "SHORTCUT_SIGNER_TOKEN", label: "Shortcut signer token" },
  { key: "foodie_api_url", label: "Chewable Foodie URL", inputType: "text" },
  { key: "foodie_api_key", label: "Chewable Foodie API key" },
];

const KNOWN_SECRET_SECTIONS = new Map([
  ...AI_PROVIDER_KEYS.map((d) => [d.key, "API keys"] as const),
  ...DATA_SOURCE_KEYS.map((d) => [d.key, "Data sources"] as const),
  ["GOOGLE_CLIENT_ID", "Google"],
  ["GOOGLE_CLIENT_SECRET", "Google"],
  ["SPOTIFY_CLIENT_ID", "Spotify"],
  ["SPOTIFY_CLIENT_SECRET", "Spotify"],
  ["TELEGRAM_API_KEY", "Telegram"],
  ["TELEGRAM_ALERTS_BOT_TOKEN", "Monitoring alerts"],
]);

function inferInputType(definition: SecretKeyDefinition): "password" | "text" {
  if (definition.inputType) return definition.inputType;
  return definition.key.includes("TOKEN") || definition.key.includes("KEY") || definition.key.includes("SECRET")
    ? "password"
    : "text";
}

interface SecretKeyRowProps {
  definition: SecretKeyDefinition;
  masked: string | null;
  onSave: (value: string) => Promise<boolean>;
  onDelete: () => unknown;
}

export function SecretKeyRow({ definition, masked, onSave, onDelete }: SecretKeyRowProps) {
  const Icon = definition.provider ? PROVIDER_ICONS[definition.provider] : undefined;
  return (
    <ValueRow
      label={definition.label}
      icon={Icon && <Icon className="shrink-0 text-text-muted" />}
      url={definition.url}
      value={masked}
      inputType={inferInputType(definition)}
      onSave={onSave}
      onDelete={onDelete}
    />
  );
}

interface SecretsSettingsProps {
  title: string;
  description: string;
  keys: SecretKeyDefinition[];
  secrets: SecretEntry[];
  saveApiKey: (keyName: string, value: string) => Promise<boolean>;
  deleteApiKey: (keyName: string) => Promise<void>;
  includeCustomSecrets?: boolean;
}

export function SecretsSettings({ title, description, keys, secrets, saveApiKey, deleteApiKey, includeCustomSecrets = false }: SecretsSettingsProps) {
  const [customKey, setCustomKey] = useState("");
  const [customValue, setCustomValue] = useState("");
  const customSecrets = includeCustomSecrets ? secrets.filter((s) => !KNOWN_SECRET_SECTIONS.has(s.key)) : [];
  const definitions = [...keys, ...customSecrets.map(({ key }) => ({ key, label: key, inputType: "password" as const }))];
  const customKeySection = KNOWN_SECRET_SECTIONS.get(customKey);

  async function addCustomSecret(event: React.FormEvent) {
    event.preventDefault();
    if (!customKey || !customValue.trim()) return;
    if (await saveApiKey(customKey, customValue)) {
      setCustomKey("");
      setCustomValue("");
    }
  }

  return (
    <SettingsSection title={title} description={description}>
      {definitions.length > 0 && (
        <SettingsPanel>
          {definitions.map((definition) => (
            <SecretKeyRow
              key={definition.key}
              definition={definition}
              masked={secrets.find((s) => s.key === definition.key)?.masked ?? null}
              onSave={(value) => saveApiKey(definition.key, value)}
              onDelete={() => deleteApiKey(definition.key)}
            />
          ))}
        </SettingsPanel>
      )}

      {includeCustomSecrets && (
        <form onSubmit={addCustomSecret} className="flex flex-wrap gap-2 items-end mt-3">
          <label className="flex flex-col gap-2 flex-1 min-w-[160px] text-[13px] text-text-secondary">
            Key
            <Input
              type="text"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              placeholder="MY_API_KEY"
              className="w-full h-9 !py-0 font-mono"
            />
          </label>
          <label className="flex flex-col gap-2 flex-1 min-w-[160px] text-[13px] text-text-secondary">
            Value
            <Input
              type="password"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              placeholder="Paste value"
              className="w-full h-9 !py-0 font-mono"
            />
          </label>
          <Button type="submit">Add</Button>
          {customKeySection && (
            <p className="basis-full m-0 text-[13px] text-text-muted">
              {customKey} is a built-in setting. It will show under {customKeySection}, not here.
            </p>
          )}
        </form>
      )}
    </SettingsSection>
  );
}
