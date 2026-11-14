import { useEffect, useState } from "react";
import type { AgentProviderModels } from "@chomp/shared";
import { apiFetch } from "../../lib/api";
import { Input } from "../ui";
import { SettingsSection, StatusNote } from "./SettingsSection";

const RUNTIME_NAMES = { claude: "Claude Code", codex: "Codex" } as const;

/** Embedding models per API provider, checked against the providers' live model lists (2026-11). */
const API_EMBEDDINGS: Record<"openai" | "gemini", { name: string; models: string[] }> = {
  openai: { name: "OpenAI", models: ["text-embedding-3-small", "text-embedding-3-large"] },
  gemini: { name: "Gemini", models: ["gemini-embedding-001", "gemini-embedding-2"] },
};

interface Props {
  backgroundModel: string | undefined;
  embeddingModel: string | undefined;
  save: (key: string, value: string, message?: string) => Promise<boolean>;
}

/** What Chomp itself runs on: its small jobs on a runtime login, and the vectors behind memory search. */
export function BackgroundSettings({ backgroundModel, embeddingModel, save }: Props) {
  const [runtimes, setRuntimes] = useState<AgentProviderModels[]>([]);
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const [keyed, setKeyed] = useState<string[]>([]);

  useEffect(() => {
    apiFetch("/chat/agent-models").then((r) => (r.ok ? r.json() : [])).then(setRuntimes).catch(() => {});
    apiFetch("/settings/ollama/status").then((r) => r.json()).then((d: { ready: boolean; models: Array<{ name: string }> }) => setOllamaModels(d.ready ? d.models.map((m) => m.name) : [])).catch(() => setOllamaModels([]));
    apiFetch("/settings/configured-providers").then((r) => r.json()).then((d: { providers: string[] }) => setKeyed(d.providers)).catch(() => {});
  }, []);

  const connected = runtimes.filter((r) => r.available);
  const embedding = embeddingModel || "";
  const ollamaEmbedders = (ollamaModels ?? []).filter((m) => /embed/i.test(m));

  return (
    <>
      <SettingsSection
        title="Background model"
        description="Chomp's own small jobs: pulling memories out of chats, setting up dashboard widgets, filling in forms. They run on your Claude Code or Codex login, so they cost no API tokens."
      >
        <Input
          as="select"
          aria-label="Background model"
          value={backgroundModel ?? ""}
          onChange={(e) => save("background_model", (e.target as HTMLSelectElement).value, "Background model saved")}
          className="w-full max-w-md h-9 !py-0"
        >
          <option value="">Automatic: Haiku, else gpt-6-luna</option>
          {connected.map((runtime) => (
            <optgroup key={runtime.provider} label={RUNTIME_NAMES[runtime.provider]}>
              {runtime.models.map((m) => (
                <option key={m.id} value={JSON.stringify({ provider: runtime.provider, model: m.id })}>{m.label}</option>
              ))}
            </optgroup>
          ))}
        </Input>
        {runtimes.length > 0 && connected.length === 0 && (
          <StatusNote tone="error">Log in to Claude Code or Codex first, see Agents above.</StatusNote>
        )}
      </SettingsSection>

      <SettingsSection
        title="Embeddings"
        description="The vectors behind memory search. Ollama runs them on this machine for free; OpenAI and Gemini use their API key. Changing it re-embeds your memories in the background."
      >
        <Input
          as="select"
          aria-label="Embedding model"
          value={embedding}
          onChange={(e) => save("embedding_model", (e.target as HTMLSelectElement).value, "Embedding model saved, re-embedding memories")}
          className="w-full max-w-md h-9 !py-0"
        >
          <option value="">Ollama: nomic-embed-text (default)</option>
          {ollamaEmbedders.filter((m) => !m.startsWith("nomic-embed-text")).map((m) => (
            <option key={m} value={`ollama:${m}`}>Ollama: {m}</option>
          ))}
          {(Object.keys(API_EMBEDDINGS) as Array<keyof typeof API_EMBEDDINGS>).map((provider) => (
            <optgroup key={provider} label={keyed.includes(provider) ? API_EMBEDDINGS[provider].name : `${API_EMBEDDINGS[provider].name} (add its key below)`}>
              {API_EMBEDDINGS[provider].models.map((m) => (
                <option key={m} value={`${provider}:${m}`} disabled={!keyed.includes(provider)}>{API_EMBEDDINGS[provider].name}: {m}</option>
              ))}
            </optgroup>
          ))}
        </Input>
        {!embedding && ollamaModels !== null && !ollamaModels.some((m) => m.startsWith("nomic-embed-text")) && (
          <StatusNote tone="error">Ollama with nomic-embed-text is not available here. Pick OpenAI or Gemini, or run `ollama pull nomic-embed-text`.</StatusNote>
        )}
      </SettingsSection>
    </>
  );
}
