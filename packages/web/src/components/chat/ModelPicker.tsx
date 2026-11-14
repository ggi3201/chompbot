import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search, Zap } from "lucide-react";
import {
  ACCESS_MODE_LABELS,
  ACCESS_MODES,
  type AccessMode,
  type AgentModelOption,
  type AgentProvider,
  type AgentProviderModels,
  type AgentSelection,
} from "@chomp/shared";
import { Input } from "../ui";
import { ClaudeIcon, OpenAIIcon } from "../ProviderIcons";
import { effortLabel } from "../../lib/agent-selection";
import { isTouch } from "../../hooks/useIsMobile";
import type { SoulOption } from "./SoulMenu";

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function ProviderIcon({ provider, size = 16 }: { provider: AgentProvider; size?: number }) {
  return provider === "claude" ? <ClaudeIcon size={size} /> : <OpenAIIcon size={size} />;
}

function findModel(providers: AgentProviderModels[], selection: AgentSelection): AgentModelOption | undefined {
  return providers.find((p) => p.provider === selection.provider)?.models.find((m) => m.id === selection.model);
}

export function selectionLabel(providers: AgentProviderModels[], selection: AgentSelection): string {
  const model = findModel(providers, selection);
  const label = model?.label ?? selection.model;
  return selection.effort ? `${label} · ${effortLabel(selection.effort)}` : label;
}

function matches(model: AgentModelOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  return [model.label, model.id, model.description ?? ""].some((text) => text.toLowerCase().includes(q));
}

const SEGMENT = "h-7 px-2.5 rounded-[5px] border-none text-[13px] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-40";

/**
 * The composer's agent control: one button that opens a panel with providers
 * on the left, their models in the middle and the chosen model's reasoning
 * efforts on the right, with the soul (who answers) next to speed and access.
 * ⌘1–⌘4 pick the first four listed models.
 */
export default function ModelPicker({
  providers,
  selection,
  onChange,
  souls = [],
  soulId,
}: {
  providers: AgentProviderModels[];
  selection: AgentSelection | undefined;
  onChange: (selection: AgentSelection) => void;
  souls?: SoulOption[];
  /** The chosen soul, undefined for the default one. */
  soulId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState<AgentProvider | null>(null);
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointer);
    return () => document.removeEventListener("pointerdown", handlePointer);
  }, [open]);

  if (!selection) {
    return (
      <span className="h-7 px-2 flex items-center text-[13px] text-text-muted">
        {providers.length === 0 ? "Loading models" : "No agent available"}
      </span>
    );
  }

  const current = selection;
  const defaultSoul = souls.find((s) => s.isDefault);
  // Only a soul picked on purpose earns room on the button; the default one goes unsaid.
  const pickedSoul = souls.find((s) => s.id === soulId && !s.isDefault);
  const selectedModel = findModel(providers, current);
  const browsed = providers.find((p) => p.provider === (browsing ?? current.provider)) ?? providers[0];
  const searching = query.trim().length > 0;
  const listed = (browsed?.models ?? []).filter((m) =>
    searching ? matches(m, query) : m.featured || showMore,
  );
  const hiddenCount = (browsed?.models ?? []).filter((m) => !m.featured).length;

  function pickModel(provider: AgentProviderModels, model: AgentModelOption) {
    const keepsEffort = current.effort && model.efforts.includes(current.effort);
    onChange({
      provider: provider.provider,
      // The soul is independent of the engine and model.
      ...(current.soulId ? { soulId: current.soulId } : {}),
      model: model.id,
      ...(keepsEffort ? { effort: current.effort } : model.defaultEffort ? { effort: model.defaultEffort } : {}),
      fast: model.supportsFast && !!current.fast,
      access: current.access,
    });
  }

  function update(patch: Partial<AgentSelection>) {
    onChange({ ...current, ...patch });
  }

  function toggle() {
    setOpen((v) => !v);
    setBrowsing(null);
    setQuery("");
    setShowMore(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    const index = Number(e.key) - 1;
    if ((e.metaKey || e.ctrlKey) && index >= 0 && index < 4 && browsed?.available && listed[index]) {
      e.preventDefault();
      pickModel(browsed, listed[index]);
    }
  }

  return (
    <div ref={rootRef} className="min-w-0 flex">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex items-center gap-1.5 h-7 px-2 min-w-0 max-w-[16rem] rounded-md border-none text-[13px] cursor-pointer transition-colors ${
          open ? "bg-raised text-text-primary" : "bg-transparent text-text-secondary hover:bg-raised hover:text-text-primary"
        }`}
      >
        <span className="shrink-0 flex text-text-muted"><ProviderIcon provider={current.provider} size={14} /></span>
        <span className="truncate">{pickedSoul ? `${pickedSoul.name} · ` : ""}{selectionLabel(providers, current)}</span>
        {current.fast && <Zap size={12} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-label="Fast" />}
        <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a model"
          onKeyDown={handleKeyDown}
          className="absolute bottom-full left-0 mb-2 z-30 w-full max-w-[640px] rounded-lg border border-border bg-glass shadow-modal flex flex-col overflow-hidden"
        >
          <div className="flex min-h-0 max-h-[min(420px,60vh)]">
            {/* Providers */}
            <div className="flex flex-col gap-1 p-1.5 border-r border-border shrink-0">
              {providers.map((p) => (
                <button
                  key={p.provider}
                  type="button"
                  onClick={() => { setBrowsing(p.provider); setShowMore(false); }}
                  title={p.available ? PROVIDER_LABELS[p.provider] : `${PROVIDER_LABELS[p.provider]}: ${p.reason ?? "not available"}`}
                  aria-label={PROVIDER_LABELS[p.provider]}
                  aria-pressed={p.provider === browsed?.provider}
                  className={`flex items-center justify-center w-8 h-8 rounded-md border-none cursor-pointer transition-colors ${
                    p.provider === browsed?.provider ? "bg-raised text-text-primary" : "bg-transparent text-text-muted hover:text-text-primary"
                  } ${p.available ? "" : "opacity-40"}`}
                >
                  <ProviderIcon provider={p.provider} />
                </button>
              ))}
            </div>

            {/* Models */}
            <div className="flex flex-col flex-1 min-w-0">
              <label className="flex items-center gap-2 px-3 h-10 border-b border-border text-text-muted">
                <Search size={14} strokeWidth={1.5} className="shrink-0" />
                <input
                  autoFocus={!isTouch}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${browsed ? PROVIDER_LABELS[browsed.provider] : ""} models`}
                  className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-text-primary placeholder:text-text-muted"
                />
              </label>
              {browsed && !browsed.available ? (
                <p className="m-0 p-3 text-[13px] text-text-muted">
                  {PROVIDER_LABELS[browsed.provider]} is not available{browsed.reason ? `: ${browsed.reason}` : ""}
                </p>
              ) : (
                <ul className="list-none m-0 p-1.5 overflow-auto flex flex-col gap-0.5">
                  {listed.map((model, index) => {
                    const isSelected = browsed?.provider === current.provider && model.id === current.model;
                    return (
                      <li key={model.id}>
                        <button
                          type="button"
                          onClick={() => browsed && pickModel(browsed, model)}
                          className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md border-none text-left cursor-pointer transition-colors ${
                            isSelected ? "bg-raised" : "bg-transparent hover:bg-white/4"
                          }`}
                        >
                          <span className="flex flex-col flex-1 min-w-0">
                            <span className="text-[13px] text-text-primary truncate">{model.label}</span>
                            {model.description && (
                              <span className="text-xs text-text-muted truncate">{model.description}</span>
                            )}
                          </span>
                          {index < 4 && <span className="font-mono text-xs text-text-muted shrink-0">⌘{index + 1}</span>}
                          <span className="w-4 shrink-0 flex text-accent-ink">
                            {isSelected && <Check size={14} strokeWidth={1.5} />}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {listed.length === 0 && (
                    <li className="px-2 py-1.5 text-[13px] text-text-muted">No models match</li>
                  )}
                  {!searching && hiddenCount > 0 && (
                    <li>
                      <button
                        type="button"
                        onClick={() => setShowMore((v) => !v)}
                        className="w-full px-2 py-1.5 rounded-md border-none bg-transparent text-left text-[13px] text-text-muted cursor-pointer transition-colors hover:text-text-primary"
                      >
                        {showMore ? "Show fewer" : `Show more (${hiddenCount})`}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>

            {/* Reasoning */}
            {selectedModel && selectedModel.efforts.length > 0 && (
              <div className="flex flex-col w-48 shrink-0 border-l border-border">
                <div className="flex items-center px-3 h-10 border-b border-border text-xs text-text-muted">Reasoning</div>
                <ul className="list-none m-0 p-1.5 overflow-auto flex flex-col gap-0.5">
                  {selectedModel.efforts.map((effort) => {
                    const isCurrent = effort === (current.effort ?? selectedModel.defaultEffort);
                    return (
                      <li key={effort}>
                        <button
                          type="button"
                          onClick={() => update({ effort })}
                          className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md border-none text-left cursor-pointer transition-colors ${
                            isCurrent ? "bg-raised" : "bg-transparent hover:bg-white/4"
                          }`}
                        >
                          <span className="flex-1 min-w-0 text-[13px] text-text-primary truncate">{effortLabel(effort)}</span>
                          {effort === selectedModel.defaultEffort && (
                            <span className="font-mono text-[11px] text-text-muted">Default</span>
                          )}
                          <span className="w-3.5 shrink-0 flex text-accent-ink">
                            {isCurrent && <Check size={14} strokeWidth={1.5} />}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* Speed and access */}
          <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-t border-border">
            <div className="flex p-0.5 rounded-md bg-surface-alt border border-border">
              {[
                { label: "Standard", fast: false },
                { label: "Fast", fast: true },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  disabled={!selectedModel?.supportsFast}
                  onClick={() => update({ fast: option.fast })}
                  aria-pressed={!!current.fast === option.fast}
                  className={`${SEGMENT} ${
                    !!current.fast === option.fast ? "bg-raised text-text-primary" : "bg-transparent text-text-muted hover:text-text-primary"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {souls.length > 0 && (
              <Input
                as="select"
                value={soulId ?? ""}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ soulId: e.target.value || undefined })}
                aria-label="Agent: who answers"
                title="Agent: who answers"
                className="ml-auto !h-7 !py-0 !px-2 !text-[13px] !w-auto max-w-[10rem] cursor-pointer"
              >
                <option value="">{defaultSoul?.name ?? "No agent"}</option>
                {souls.filter((s) => s !== defaultSoul).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Input>
            )}
            <Input
              as="select"
              value={current.access}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => update({ access: e.target.value as AccessMode })}
              aria-label="Access"
              className={`${souls.length > 0 ? "" : "ml-auto "}!h-7 !py-0 !px-2 !text-[13px] !w-auto cursor-pointer`}
            >
              {ACCESS_MODES.map((mode) => (
                <option key={mode} value={mode}>{ACCESS_MODE_LABELS[mode]}</option>
              ))}
            </Input>
          </div>
        </div>
      )}
    </div>
  );
}
