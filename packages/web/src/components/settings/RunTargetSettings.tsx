import { useEffect, useState } from "react";
import type { RunTarget } from "@chomp/shared";
import { useAgentModels } from "../../hooks/useAgentModels";
import { useCrud } from "../../hooks/useCrud";
import { apiFetch } from "../../lib/api";
import type { SoulOption } from "../chat/SoulMenu";
import RunTargetFields from "../RunTargetFields";
import { SettingsPanel, SettingsSection } from "./SettingsSection";

const CHANNELS = [
  { id: "discord", settingKey: "run_target_discord", label: "Discord", description: "Normal Discord messages without an @mention" },
  { id: "telegram", settingKey: "run_target_telegram", label: "Telegram", description: "Normal Telegram messages without an @mention" },
] as const;

type SavedTargets = Record<"default" | (typeof CHANNELS)[number]["id"], RunTarget>;

export function RunTargetSettings({ onSaved, onError }: { onSaved: (text: string) => void; onError: (text: string) => void }) {
  const providers = useAgentModels();
  const { items: souls, update: updateSoul, refresh: refreshSouls } = useCrud<SoulOption>("/souls");
  const [targets, setTargets] = useState<SavedTargets | null>(null);

  useEffect(() => {
    apiFetch("/chat/run-targets")
      .then((res) => (res.ok ? res.json() as Promise<SavedTargets> : null))
      .then(setTargets)
      .catch(() => onError("Could not load the default agents"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!targets) return null;

  async function save(id: keyof SavedTargets, settingKey: string, label: string, target: RunTarget) {
    setTargets((current) => (current ? { ...current, [id]: target } : current));
    const res = await apiFetch(`/settings/${settingKey}`, { method: "PUT", body: JSON.stringify({ value: JSON.stringify(target) }) });
    if (res.ok) onSaved(`${label} saved`);
    else onError(`Could not save ${label}`);
  }

  // The overall default agent is the soul marked as default, the one chat and every other surface fall back to.
  const defaultSoul = souls.find((soul) => soul.isDefault);

  async function saveDefault({ soulId, ...engine }: RunTarget) {
    if (soulId !== defaultSoul?.id) {
      if (soulId) await updateSoul(soulId, { isDefault: true });
      else if (defaultSoul) await updateSoul(defaultSoul.id, { isDefault: false });
      await refreshSouls();
    }
    await save("default", "run_target", "Default", engine);
  }

  return (
    <SettingsSection
      title="Default agents"
      description="Which agent runs, on which provider and model, when nothing more specific is chosen. Anything can override this: the chat composer, a rule, or an @mention of a soul like @Spicy. Supervised access asks your phone before the agent acts."
    >
      <SettingsPanel>
        <div className="p-4">
          <h4 className="m-0 text-[13px] font-medium text-text-primary">Default</h4>
          <p className="m-0 mt-1 mb-3 text-xs text-text-muted">
            For anything without its own choice, like proactive rules and widgets. Web chat remembers what you last picked in the composer.
          </p>
          <RunTargetFields
            value={{ ...targets.default, ...(defaultSoul ? { soulId: defaultSoul.id } : {}) }}
            onChange={saveDefault}
            providers={providers}
            souls={souls}
            inheritAgent="No agent"
            inheritProvider="Claude"
          />
        </div>
        {CHANNELS.map((channel) => (
          <div key={channel.id} className="p-4">
            <h4 className="m-0 text-[13px] font-medium text-text-primary">{channel.label}</h4>
            <p className="m-0 mt-1 mb-3 text-xs text-text-muted">{channel.description}</p>
            <RunTargetFields
              value={targets[channel.id]}
              onChange={(target) => save(channel.id, channel.settingKey, channel.label, target)}
              providers={providers}
              souls={souls}
              inheritAgent="Same as default"
              inheritProvider="Same as default"
            />
          </div>
        ))}
      </SettingsPanel>
    </SettingsSection>
  );
}
