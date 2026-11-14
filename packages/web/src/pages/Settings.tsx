import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Badge, Button, Input, PageHeader, Switch } from "../components/ui";
import { AlertCircle, Check, ChevronRight } from "lucide-react";
import { GithubSettings } from "../components/settings/GithubSettings";
import { VOICES } from "../components/VoiceControls";
import {
  AI_PROVIDER_KEYS,
  DATA_SOURCE_KEYS,
  SecretKeyRow,
  SecretsSettings,
  type SecretEntry,
  type SecretKeyDefinition,
} from "../components/settings/SecretsSettings";
import { RunTargetSettings } from "../components/settings/RunTargetSettings";
import { RuntimeStatus } from "../components/settings/RuntimeStatus";
import { BackgroundSettings } from "../components/settings/BackgroundSettings";
import {
  NumberSettingRow,
  RowActions,
  RowButton,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  StatusNote,
  TextLink,
  ValueRow,
} from "../components/settings/SettingsSection";

interface OllamaStatus {
  ready: boolean;
  models: Array<{ name: string; size: number; modified: string }>;
}

interface TelegramStatus {
  /** A token saved here wins over `TELEGRAM_API_KEY` in the server's .env. */
  tokenSource: "settings" | "env" | null;
  linkedChatId: number | null;
}

interface GoogleStatus {
  connected: boolean;
}

interface SpotifyStatus {
  connected: boolean;
}

const TABS = [
  { id: "ai", label: "AI and chat" },
  { id: "agents", label: "Agent routing" },
  { id: "integrations", label: "Integrations" },
  { id: "system", label: "System" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const GUARDRAILS = [
  { key: "max_concurrent_agents", label: "Max concurrent agents", default_: 2, factor: 1, unit: "", hint: "1–10" },
  { key: "agent_idle_timeout_ms", label: "Idle timeout", default_: 45, factor: 60_000, unit: "min", hint: "Stop an agent after no output for this long, 1–120" },
  { key: "max_output_bytes", label: "Max output", default_: 2, factor: 1_048_576, unit: "MB", hint: "Per agent, 0.5–50" },
  { key: "circuit_breaker_failures", label: "Circuit breaker failures", default_: 3, factor: 1, unit: "", hint: "Before an agent is disabled, 1–50" },
  { key: "circuit_breaker_window_ms", label: "Circuit breaker window", default_: 30, factor: 60_000, unit: "min", hint: "Time span for counting failures, 1–120" },
  { key: "circuit_breaker_cooldown_ms", label: "Circuit breaker cooldown", default_: 30, factor: 60_000, unit: "min", hint: "How long a tripped agent stays disabled, 1–120" },
  { key: "max_dispatches_per_hour", label: "Max dispatches per hour", default_: 10, factor: 1, unit: "/hr", hint: "Proactive agent runs, 1–50" },
] as const;

const GOOGLE_KEYS: SecretKeyDefinition[] = [
  { key: "GOOGLE_CLIENT_ID", label: "Client ID" },
  { key: "GOOGLE_CLIENT_SECRET", label: "Client secret" },
];

const ALERTS_BOT_KEYS: SecretKeyDefinition[] = [
  { key: "TELEGRAM_ALERTS_BOT_TOKEN", label: "Bot token" },
];

const MONITORING_KEYS: SecretKeyDefinition[] = [
  { key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token", url: "https://dash.cloudflare.com/profile/api-tokens" },
  { key: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare account id", inputType: "text" },
  { key: "CLOUDFLARE_KV_NAMESPACE_ID", label: "Outside probe KV namespace", inputType: "text" },
  { key: "MONITOR_OUTSIDE_SECRET", label: "Outside probe secret" },
  { key: "MONITOR_RESTART_UNITS", label: "Units the page may restart", inputType: "text" },
];

const SPOTIFY_KEYS: SecretKeyDefinition[] = [
  { key: "SPOTIFY_CLIENT_ID", label: "Client ID" },
  { key: "SPOTIFY_CLIENT_SECRET", label: "Client secret" },
];

export default function Settings() {
  // OAuth redirects back here, so land on the tab holding the account that was just connected.
  const [tab, setTab] = useState<TabId>(() => (/[?&](google|spotify)=/.test(window.location.search) ? "integrations" : "ai"));
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "" });
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyStatus | null>(null);
  const [newRepoInput, setNewRepoInput] = useState("");
  const [backups, setBackups] = useState<Array<{ name: string; sizeBytes: number; mtime: string }>>([]);
  const [backingUp, setBackingUp] = useState(false);

  // Show success message if redirected back from Google or Spotify OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      showMessage("success", "Google account connected");
      window.history.replaceState({}, "", "/settings");
    } else if (params.get("spotify") === "connected") {
      showMessage("success", "Spotify account connected");
      window.history.replaceState({}, "", "/settings");
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const [settingsRes, ollamaRes, telegramRes, secretsRes, googleRes, spotifyRes] = await Promise.all([
          apiFetch("/settings"),
          apiFetch("/settings/ollama/status"),
          apiFetch("/telegram/status"),
          apiFetch("/settings/secrets"),
          apiFetch("/google/status"),
          apiFetch("/spotify/status"),
        ]);
        if (settingsRes.ok) {
          const data = await settingsRes.json();
          setSettings(data);
        }
        if (ollamaRes.ok) setOllamaStatus(await ollamaRes.json());
        if (telegramRes.ok) setTelegramStatus(await telegramRes.json());
        if (secretsRes.ok) setSecrets(await secretsRes.json());
        if (googleRes.ok) setGoogleStatus(await googleRes.json());
        if (spotifyRes.ok) setSpotifyStatus(await spotifyRes.json());
        const backupsRes = await apiFetch("/backups");
        if (backupsRes.ok) {
          const data = await backupsRes.json();
          setBackups(data.backups ?? []);
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  /** Only updates local state and reports success once the server has accepted the value. */
  async function saveSetting(key: string, value: string, success?: string) {
    const res = await apiFetch(`/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) });
    if (res.ok) {
      setSettings((s) => ({ ...s, [key]: value }));
      if (success) showMessage("success", success);
    } else {
      const data = await res.json().catch(() => ({}));
      showMessage("error", data.error ?? "Failed to save");
    }
    return res.ok;
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (passwords.newPassword.length < 8) {
      showMessage("error", "New password must be at least 8 characters");
      return;
    }
    const res = await apiFetch("/settings/change-password", {
      method: "POST",
      body: JSON.stringify(passwords),
    });
    if (res.ok) {
      showMessage("success", "Password changed");
      setPasswords({ currentPassword: "", newPassword: "" });
    } else {
      const data = await res.json();
      showMessage("error", data.error ?? "Failed to change password");
    }
  }

  async function saveApiKey(keyName: string, value: string) {
    if (!value.trim()) return false;
    const res = await apiFetch("/settings/secrets", {
      method: "POST",
      body: JSON.stringify({ key: keyName, value: value.trim() }),
    });
    if (res.ok) {
      showMessage("success", `${keyName} saved`);
      const secretsRes = await apiFetch("/settings/secrets");
      if (secretsRes.ok) setSecrets(await secretsRes.json());
    } else {
      showMessage("error", `Failed to save ${keyName}`);
    }
    return res.ok;
  }

  async function deleteApiKey(keyName: string) {
    const res = await apiFetch(`/settings/secrets/${keyName}`, { method: "DELETE" });
    if (res.ok) {
      showMessage("success", `${keyName} deleted`);
      const secretsRes = await apiFetch("/settings/secrets");
      if (secretsRes.ok) setSecrets(await secretsRes.json());
    } else {
      showMessage("error", `Failed to delete ${keyName}`);
    }
  }

  // The bot reads its token once, at start, so a change restarts it.
  async function restartTelegram() {
    await apiFetch("/telegram/restart", { method: "POST" });
    const statusRes = await apiFetch("/telegram/status");
    if (statusRes.ok) setTelegramStatus(await statusRes.json());
  }

  async function saveTelegramToken(value: string) {
    if (!(await saveApiKey("TELEGRAM_API_KEY", value))) return false;
    await restartTelegram();
    return true;
  }

  async function removeTelegramToken() {
    await deleteApiKey("TELEGRAM_API_KEY");
    await restartTelegram();
  }



  function showMessage(type: "success" | "error", text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  function getSecretMasked(keyName: string): string | null {
    return secrets.find((s) => s.key === keyName)?.masked ?? null;
  }

  function secretRows(definitions: SecretKeyDefinition[]) {
    return definitions.map((definition) => (
      <SecretKeyRow
        key={definition.key}
        definition={definition}
        masked={getSecretMasked(definition.key)}
        onSave={(value) => saveApiKey(definition.key, value)}
        onDelete={() => deleteApiKey(definition.key)}
      />
    ));
  }

  const telegramTokenLabels = { settings: getSecretMasked("TELEGRAM_API_KEY") ?? "set", env: "set in .env" };

  if (loading) return <div className="p-8 text-text-muted">Loading</div>;

  return (
    <div className="p-6 max-w-[720px]">
      <PageHeader title="Settings" />

      {message && (
        <div
          role="status"
          className={`fixed z-50 right-6 bottom-6 max-w-[calc(100vw-48px)] flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-raised text-[13px] ${message.type === "success" ? "text-success" : "text-error"}`}
        >
          {message.type === "success" ? <Check size={16} strokeWidth={1.5} className="shrink-0" /> : <AlertCircle size={16} strokeWidth={1.5} className="shrink-0" />}
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap gap-1 pb-3 mb-8 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-current={tab === t.id ? "true" : undefined}
            onClick={() => setTab(t.id)}
            className={`h-8 px-3 rounded-md border-none text-[13px] font-medium cursor-pointer transition-colors ${
              tab === t.id
                ? "bg-raised text-text-primary"
                : "bg-transparent text-text-secondary hover:bg-white/4 hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "ai" && (
        <>
          <SettingsSection title="Agents" description="Every chat runs on Claude Code or Codex, with the logins on this machine.">
            <RuntimeStatus />
          </SettingsSection>
          <BackgroundSettings
            backgroundModel={settings.background_model}
            embeddingModel={settings.embedding_model}
            save={saveSetting}
          />

          <SecretsSettings
            title="API keys"
            description="For skills that use other kinds of models: images, video, voice, and embeddings above. Saved encrypted, and agents get each key as an environment variable."
            keys={AI_PROVIDER_KEYS}
            secrets={secrets}
            saveApiKey={saveApiKey}
            deleteApiKey={deleteApiKey}
          />

          <SettingsSection title="Voice" description="Text-to-speech and speech-to-text">
            <SettingsPanel>
              <SettingsRow label={<label htmlFor="voice_tts_voice">Voice for speech</label>}>
                <Input
                  as="select"
                  id="voice_tts_voice"
                  value={settings.voice_tts_voice ?? "coral"}
                  onChange={(e) => {
                    const value = (e.target as HTMLSelectElement).value;
                    saveSetting("voice_tts_voice", value, `Voice set to ${value}`);
                  }}
                  className="w-40 h-8 !py-0 !text-[13px]"
                >
                  {VOICES.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </Input>
              </SettingsRow>
              <SettingsRow label="Speak replies when I talk">
                <Switch
                  label="Speak replies when I talk"
                  on={settings.voice_auto_speak === "true"}
                  onChange={(on) => saveSetting("voice_auto_speak", on ? "true" : "false")}
                />
              </SettingsRow>
            </SettingsPanel>
            {!getSecretMasked("OPENAI_API_KEY") && (
              <StatusNote>
                <AlertCircle size={16} strokeWidth={1.5} />
                Voice needs an OpenAI API key. Add one above
              </StatusNote>
            )}
          </SettingsSection>
        </>
      )}

      {tab === "agents" && (
        <RunTargetSettings onSaved={(text) => showMessage("success", text)} onError={(text) => showMessage("error", text)} />
      )}

      {tab === "integrations" && (
        <>
          <SettingsSection title="Google" description="Connect your Google account to use Gmail and Calendar from chat">
            <SetupInstructions>
              <li>Go to <TextLink href="https://console.cloud.google.com/apis/credentials">Google Cloud Console &rarr; Credentials</TextLink></li>
              <li>Create OAuth client ID &rarr; <span className="text-text-primary">Web application</span></li>
              <li>Add authorized redirect URI: <Badge>{window.location.origin}/api/google/callback</Badge></li>
              <li>Enable <TextLink href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</TextLink>, <TextLink href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</TextLink> and <TextLink href="https://console.cloud.google.com/apis/library/drive.googleapis.com">Google Drive API</TextLink></li>
              <li>Under <span className="text-text-primary">OAuth consent screen &rarr; Scopes</span>, add:
                <span className="flex flex-col mt-1 font-mono text-xs text-text-muted">
                  <span>https://www.googleapis.com/auth/gmail.readonly</span>
                  <span>https://www.googleapis.com/auth/gmail.compose</span>
                  <span>https://www.googleapis.com/auth/calendar.events</span>
                  <span>https://www.googleapis.com/auth/calendar.readonly</span>
                  <span>https://www.googleapis.com/auth/drive</span>
                </span>
              </li>
              <li>Add your Gmail address as a <span className="text-text-primary">test user</span> (no verification needed for personal use)</li>
              <li>Add the client ID and secret below and click Connect</li>
            </SetupInstructions>

            <SettingsPanel>
              {secretRows(GOOGLE_KEYS)}
              <OAuthRow
                service="google"
                name="Google"
                connected={!!googleStatus?.connected}
                ready={GOOGLE_KEYS.every((d) => getSecretMasked(d.key))}
                onDisconnected={() => setGoogleStatus({ connected: false })}
                showMessage={showMessage}
              />
              {googleStatus?.connected && (
                <ValueRow
                  label="Drive folder"
                  hint="The last part of the folder's URL"
                  value={settings.drive_folder_id || null}
                  placeholder="1AbC2dEfG3hIjK4lMnOpQ5rStUvWxYz"
                  onSave={(value) => saveSetting("drive_folder_id", value, "Drive folder saved")}
                  onDelete={() => saveSetting("drive_folder_id", "", "Drive folder cleared")}
                />
              )}
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection title="Spotify" description="Connect your Spotify account to search music and podcasts from chat">
            <SetupInstructions>
              <li>Go to the <TextLink href="https://developer.spotify.com/dashboard">Spotify Developer Dashboard</TextLink> &rarr; <span className="text-text-primary">Create app</span></li>
              <li>Add this redirect URI: <Badge>{window.location.origin}/api/spotify/callback</Badge></li>
              <li>Select <span className="text-text-primary">Web API</span> under "Which API/SDKs are you planning to use?"</li>
              <li>Save the app, then copy the <span className="text-text-primary">Client ID</span> and <span className="text-text-primary">Client secret</span></li>
              <li>Add them below and click Connect</li>
            </SetupInstructions>

            <SettingsPanel>
              {secretRows(SPOTIFY_KEYS)}
              <OAuthRow
                service="spotify"
                name="Spotify"
                connected={!!spotifyStatus?.connected}
                ready={SPOTIFY_KEYS.every((d) => getSecretMasked(d.key))}
                onDisconnected={() => setSpotifyStatus({ connected: false })}
                showMessage={showMessage}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Telegram"
            description={<>Get a bot token from <TextLink href="https://t.me/BotFather">@BotFather</TextLink>, then send <Badge>/start</Badge> to your bot to link it</>}
          >
            <SettingsPanel>
              <ValueRow
                label="Bot token"
                hint={telegramStatus?.tokenSource === "env" ? "From the server's .env. A token saved here replaces it." : undefined}
                value={telegramStatus?.tokenSource ? telegramTokenLabels[telegramStatus.tokenSource] : null}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                inputType="password"
                onSave={saveTelegramToken}
                // A token in .env can only be removed on the server.
                onDelete={telegramStatus?.tokenSource === "settings" ? removeTelegramToken : undefined}
              />
              <SettingsRow
                label="Chat"
                value={telegramStatus?.linkedChatId ? `linked ${telegramStatus.linkedChatId}` : "not linked"}
                tone={telegramStatus?.linkedChatId ? "success" : "muted"}
              >
                <RowActions>
                  <RowButton
                    onClick={async () => {
                      const res = await apiFetch("/telegram/test", { method: "POST" });
                      if (res.ok) {
                        showMessage("success", "Test message sent to Telegram");
                      } else {
                        const data = await res.json();
                        showMessage("error", data.error ?? "Test failed");
                      }
                    }}
                  >
                    Test
                  </RowButton>
                </RowActions>
              </SettingsRow>
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Monitoring"
            description="The Cloudflare token lets discovery read the tunnel and DNS, so public services show as public. It needs Zone DNS read and Cloudflare Tunnel read, plus Workers KV edit for the outside probe. The account id is only needed when the token sees more than one account."
          >
            <SettingsPanel>{secretRows(MONITORING_KEYS)}</SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Monitoring alerts"
            description="A second Telegram bot that sends incident alerts, apart from the chat bot above. Alerts are skipped until the token and chat are set."
          >
            <SettingsPanel>
              {secretRows(ALERTS_BOT_KEYS)}
              <ValueRow
                label="Alerts chat id"
                hint="Where alerts go"
                value={settings.telegram_alerts_chat_id || null}
                inputType="text"
                placeholder="-1001234567890"
                onSave={(value) => saveSetting("telegram_alerts_chat_id", value, "Alerts chat saved")}
                onDelete={() => saveSetting("telegram_alerts_chat_id", "", "Alerts chat cleared")}
              />
              <ValueRow
                label="Owner id"
                hint="The Telegram user the Diagnose button answers"
                value={settings.telegram_alerts_owner_id || null}
                inputType="text"
                placeholder="123456789"
                onSave={(value) => saveSetting("telegram_alerts_owner_id", value, "Owner saved")}
                onDelete={() => saveSetting("telegram_alerts_owner_id", "", "Owner cleared")}
              />
            </SettingsPanel>
          </SettingsSection>

          <GithubSettings
            settings={settings}
            setSettings={setSettings}
            newRepoInput={newRepoInput}
            setNewRepoInput={setNewRepoInput}
            showMessage={showMessage}
          />

          <SecretsSettings
            title="Data sources"
            description="Keys for external data skills like stocks, news and smart home. All keys are encrypted at rest."
            keys={DATA_SOURCE_KEYS}
            secrets={secrets}
            saveApiKey={saveApiKey}
            deleteApiKey={deleteApiKey}
          />

          <SecretsSettings
            title="Custom secrets"
            description="Store any key-value secrets for custom skills or integrations. Encrypted at rest."
            keys={[]}
            secrets={secrets}
            saveApiKey={saveApiKey}
            deleteApiKey={deleteApiKey}
            includeCustomSecrets
          />
        </>
      )}

      {tab === "system" && (
        <>
          <SettingsSection
            title="Agent guardrails"
            description="How many agents can run at once, and the safety limits around them. Changes take effect immediately."
          >
            <SettingsPanel>
              {GUARDRAILS.map(({ key, label, default_, factor, unit, hint }) => (
                <NumberSettingRow
                  key={key}
                  id={key}
                  label={label}
                  hint={hint}
                  unit={unit}
                  factor={factor}
                  defaultValue={default_}
                  stored={settings[key]}
                  onSave={(raw) => saveSetting(key, raw, `${label} saved`)}
                />
              ))}
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection title="Ollama" description="Local inference server. Used when the chat provider is Ollama.">
            {ollamaStatus ? (
              <SettingsPanel>
                <SettingsRow
                  label="Server"
                  value={ollamaStatus.ready ? "connected" : "not reachable"}
                  tone={ollamaStatus.ready ? "success" : "error"}
                />
                {ollamaStatus.models.map((m) => (
                  <SettingsRow key={m.name} label={<span className="font-mono truncate">{m.name}</span>} value={`${(m.size / 1e9).toFixed(1)} GB`} tone="muted" />
                ))}
              </SettingsPanel>
            ) : (
              <p className="m-0 text-[13px] text-text-muted">Unable to check Ollama status</p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Claude Code sync"
            description={<>Import or export skills, MCP servers and plugins between Chomp and your local <Badge>~/.claude/</Badge> directory</>}
          >
            <div className="flex flex-wrap gap-2 items-center">
              <Button
                onClick={async () => {
                  const res = await apiFetch("/sync/pull", { method: "POST" });
                  if (res.ok) {
                    const data = await res.json();
                    const s = data.skills ?? {};
                    const m = data.mcpServers ?? {};
                    setSyncResult(`Skills: ${s.imported ?? 0} new, ${s.updated ?? 0} updated | MCP: ${m.imported ?? 0} new, ${m.updated ?? 0} updated`);
                    showMessage("success", "Import complete");
                  } else {
                    showMessage("error", "Import failed");
                  }
                }}
              >
                Import from ~/.claude
              </Button>
              <Button
                onClick={async () => {
                  const res = await apiFetch("/sync/push", { method: "POST" });
                  if (res.ok) {
                    const data = await res.json();
                    setSyncResult(`Pushed ${data.skills} skills, MCP synced`);
                    showMessage("success", "Push complete");
                  } else {
                    showMessage("error", "Push failed");
                  }
                }}
              >
                Push to ~/.claude
              </Button>
            </div>
            {syncResult && <p className="m-0 mt-3 font-mono text-xs text-text-muted">{syncResult}</p>}
          </SettingsSection>

          <SettingsSection
            title="Database backups"
            description={<>Daily SQLite snapshots of <Badge>chomp.db</Badge> at 03:00 local time, stored in <Badge>data/backups/</Badge></>}
          >
            <SettingsPanel>
              <NumberSettingRow
                id="backup_retention_days"
                label="Retention"
                hint="Older snapshots are pruned automatically, 1–365"
                unit="days"
                defaultValue={30}
                stored={settings.backup_retention_days}
                onSave={(raw) => saveSetting("backup_retention_days", raw, "Retention saved")}
              />
              {backups.length === 0 && <SettingsRow label="No backups yet" hint="Run one now or wait for the daily job" />}
              {backups.slice(0, 10).map((b) => (
                <SettingsRow
                  key={b.name}
                  label={<span className="font-mono truncate">{b.name}</span>}
                  value={`${(b.sizeBytes / 1e6).toFixed(1)} MB · ${new Date(b.mtime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`}
                  tone="muted"
                />
              ))}
            </SettingsPanel>
            <Button
              className="mt-3"
              disabled={backingUp}
              onClick={async () => {
                setBackingUp(true);
                try {
                  const res = await apiFetch("/backups/run", { method: "POST" });
                  if (res.ok) {
                    showMessage("success", "Backup created");
                    const listRes = await apiFetch("/backups");
                    if (listRes.ok) setBackups((await listRes.json()).backups ?? []);
                  } else {
                    const data = await res.json().catch(() => ({}));
                    showMessage("error", data.error ?? "Backup failed");
                  }
                } finally {
                  setBackingUp(false);
                }
              }}
            >
              {backingUp ? "Backing up" : "Run backup now"}
            </Button>
          </SettingsSection>

          <SettingsSection title="Change password" description="The login password for the Chomp web UI">
            <form onSubmit={changePassword}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-2 min-w-0 text-[13px] text-text-secondary">
                  Current password
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={passwords.currentPassword}
                    onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
                    className="w-full h-9 !py-0"
                  />
                </label>
                <label className="flex flex-col gap-2 min-w-0 text-[13px] text-text-secondary">
                  New password
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={passwords.newPassword}
                    onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
                    className="w-full h-9 !py-0"
                  />
                </label>
              </div>
              <Button type="submit" variant="primary" className="mt-3">Change password</Button>
            </form>
          </SettingsSection>
        </>
      )}
    </div>
  );
}


interface OAuthRowProps {
  service: "google" | "spotify";
  name: string;
  connected: boolean;
  ready: boolean;
  onDisconnected: () => void;
  showMessage: (type: "success" | "error", text: string) => void;
}

function OAuthRow({ service, name, connected, ready, onDisconnected, showMessage }: OAuthRowProps) {
  return (
    <SettingsRow label="Account" value={connected ? "connected" : "not connected"} tone={connected ? "success" : "muted"}>
      <RowActions>
        {connected ? (
          <RowButton
            onClick={async () => {
              const res = await apiFetch(`/${service}/disconnect`, { method: "POST" });
              if (res.ok) {
                onDisconnected();
                showMessage("success", `${name} disconnected`);
              } else {
                showMessage("error", `Failed to disconnect ${name}`);
              }
            }}
          >
            Disconnect
          </RowButton>
        ) : (
          <Button
            size="sm"
            variant={ready ? "primary" : "ghost"}
            onClick={async () => {
              const res = await apiFetch(`/${service}/auth-url`);
              if (res.ok) {
                const { url } = await res.json();
                window.location.href = url;
              } else {
                showMessage("error", "Set client ID and client secret first");
              }
            }}
          >
            Connect
          </Button>
        )}
      </RowActions>
    </SettingsRow>
  );
}

function SetupInstructions({ children }: { children: React.ReactNode }) {
  return (
    <details className="mb-3 group">
      <summary className="inline-flex items-center gap-1 text-[13px] text-text-secondary cursor-pointer select-none transition-colors hover:text-text-primary list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} strokeWidth={1.5} className="text-text-muted transition-[transform,opacity] group-open:rotate-90" />
        Setup instructions
      </summary>
      <div className="mt-2 p-4 bg-surface-alt border border-border rounded-md text-[13px] text-text-secondary leading-relaxed">
        <ol className="m-0 pl-5 flex flex-col gap-1">{children}</ol>
      </div>
    </details>
  );
}
