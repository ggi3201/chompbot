import { ACCESS_MODES, ACCESS_MODE_LABELS, type AccessMode, type AgentProvider, type AgentProviderModels, type RunTarget } from "@chomp/shared";
import { effortLabel } from "../lib/agent-selection";
import { Input } from "./ui";

const PROVIDER_LABELS: Record<AgentProvider, string> = { claude: "Claude", codex: "Codex" };

function Field({ label, value, onChange, disabled, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 min-w-0 text-xs font-medium text-text-secondary">
      {label}
      <Input
        as="select"
        value={value}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        className="!text-[13px]"
      >
        {children}
      </Input>
    </label>
  );
}

/** The target saved on a rule, trigger, widget or schedule; those configs are free-form JSON. */
export function readRunTarget(config: Record<string, unknown>): RunTarget {
  const { provider, soulId, model, effort, access } = config;
  return {
    ...(provider === "claude" || provider === "codex" ? { provider } : {}),
    ...(typeof soulId === "string" && soulId ? { soulId } : {}),
    ...(typeof model === "string" && model ? { model } : {}),
    ...(typeof effort === "string" && effort ? { effort } : {}),
    ...(ACCESS_MODES.includes(access as AccessMode) ? { access: access as AccessMode } : {}),
  };
}

/**
 * Picks who runs something: the agent (a soul) and, separately, the provider,
 * model and reasoning, and how much it may do without asking. An empty choice
 * inherits; the labels say what from.
 */
export default function RunTargetFields({ value, onChange, providers, souls, inheritAgent = "Default", inheritProvider = "Default" }: {
  value: RunTarget;
  onChange: (value: RunTarget) => void;
  providers: AgentProviderModels[];
  souls: Array<{ id: string; name: string }>;
  inheritAgent?: string;
  inheritProvider?: string;
}) {
  const catalogue = providers.find((p) => p.provider === value.provider);
  const model = catalogue?.models.find((m) => m.id === value.model);
  // A saved model the catalogue no longer lists (or has not loaded yet) stays visible.
  const unlistedModel = value.model && !model ? value.model : undefined;
  const efforts = model?.efforts ?? [];

  function pickProvider(provider: string) {
    const { soulId, access } = value;
    onChange({ ...(soulId ? { soulId } : {}), ...(access ? { access } : {}), ...(provider ? { provider: provider as AgentProvider } : {}) });
  }

  function pickModel(id: string) {
    const { soulId, access, provider } = value;
    const keepsEffort = value.effort && catalogue?.models.find((m) => m.id === id)?.efforts.includes(value.effort);
    onChange({
      ...(soulId ? { soulId } : {}),
      ...(access ? { access } : {}),
      ...(provider ? { provider } : {}),
      ...(id ? { model: id } : {}),
      ...(keepsEffort ? { effort: value.effort } : {}),
    });
  }

  function pickSoul(soulId: string) {
    const { soulId: _previous, ...rest } = value;
    onChange({ ...rest, ...(soulId ? { soulId } : {}) });
  }

  function pickEffort(effort: string) {
    const { effort: _previous, ...rest } = value;
    onChange({ ...rest, ...(effort ? { effort } : {}) });
  }

  function pickAccess(access: string) {
    const { access: _previous, ...rest } = value;
    onChange({ ...rest, ...(access ? { access: access as AccessMode } : {}) });
  }

  return (
    <div className="@container"><div className="grid grid-cols-2 @xl:grid-cols-5 gap-3">
      <Field label="Agent" value={value.soulId ?? ""} onChange={pickSoul}>
        <option value="">{inheritAgent}</option>
        {souls.map((soul) => <option key={soul.id} value={soul.id}>{soul.name}</option>)}
      </Field>
      <Field label="Provider" value={value.provider ?? ""} onChange={pickProvider}>
        <option value="">{inheritProvider}</option>
        {providers.map((p) => (
          <option key={p.provider} value={p.provider} disabled={!p.available}>
            {PROVIDER_LABELS[p.provider]}{p.available ? "" : " (not available)"}
          </option>
        ))}
      </Field>
      <Field label="Model" value={value.model ?? ""} onChange={pickModel} disabled={!value.provider}>
        <option value="">Default</option>
        {unlistedModel && <option value={unlistedModel}>{unlistedModel}</option>}
        {catalogue?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </Field>
      <Field label="Reasoning" value={value.effort ?? ""} onChange={pickEffort} disabled={efforts.length === 0}>
        <option value="">Default</option>
        {efforts.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
      </Field>
      <Field label="Access" value={value.access ?? ""} onChange={pickAccess}>
        <option value="">{inheritProvider}</option>
        {ACCESS_MODES.map((mode) => <option key={mode} value={mode}>{ACCESS_MODE_LABELS[mode]}</option>)}
      </Field>
    </div></div>
  );
}
