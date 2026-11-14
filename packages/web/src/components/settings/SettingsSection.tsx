import { useState, type FormEvent } from "react";
import { ExternalLink, RotateCcw, X } from "lucide-react";
import { displayFromRaw, rawFromDisplay } from "../../lib/setting-units";
import { Button, IconButton, Input } from "../ui";

interface SettingsSectionProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="mb-12">
      <h3 className="m-0 text-[15px] font-medium text-text-primary">{title}</h3>
      {description && <p className="m-0 mt-1 text-[13px] text-text-secondary leading-relaxed">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Quiet status line under a control: success and error mean good and bad, anything else stays muted. */
export function StatusNote({ tone = "muted", children }: { tone?: "success" | "error" | "muted"; children: React.ReactNode }) {
  const tones = { success: "text-success", error: "text-error", muted: "text-text-muted" } as const;
  return <p className={`m-0 mt-2 flex items-center gap-2 text-[13px] ${tones[tone]}`}>{children}</p>;
}

export function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-text-primary underline decoration-white/24 underline-offset-2 transition-colors hover:decoration-white/60"
    >
      {children}
    </a>
  );
}

export function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col divide-y divide-border border border-border rounded-md bg-glass">{children}</div>;
}

const valueTones = {
  secondary: "text-text-secondary",
  muted: "text-text-muted",
  success: "text-success",
  error: "text-error",
} as const;

interface SettingsRowProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  value?: string;
  tone?: keyof typeof valueTones;
  children?: React.ReactNode;
}

/** One line of a panel: what it is on the left, its state in a mono column, then whatever acts on it. */
export function SettingsRow({ label, hint, icon, value, tone = "secondary", children }: SettingsRowProps) {
  return (
    <div className="flex items-center gap-3 min-h-10 px-3 py-1">
      {icon}
      <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 sm:flex-1">
          <div className="flex items-center gap-2 text-[13px] text-text-primary">{label}</div>
          {hint && <div className="text-xs text-text-muted">{hint}</div>}
        </div>
        {value && <span title={value} className={`truncate sm:max-w-[50%] font-mono text-xs tabular-nums ${valueTones[tone]}`}>{value}</span>}
      </div>
      {children}
    </div>
  );
}

/** Fixed width so the value column lines up across every row in a panel. */
export function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="min-w-[100px] shrink-0 flex items-center justify-end gap-1">{children}</div>;
}

const rowButtonTones = {
  default: "text-text-secondary hover:text-text-primary",
  danger: "text-error",
} as const;

export function RowButton({ tone = "default", className = "", ...props }: React.ComponentPropsWithoutRef<"button"> & { tone?: keyof typeof rowButtonTones }) {
  return (
    <button
      type="button"
      className={`h-8 px-2 rounded-md bg-transparent border-none text-[13px] cursor-pointer transition-colors hover:bg-white/4 ${rowButtonTones[tone]} ${className}`}
      {...props}
    />
  );
}

interface ValueRowProps {
  label: string;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  url?: string;
  value: string | null;
  placeholder?: string;
  inputType?: "password" | "text";
  /** Resolves true when saved, which closes the editor. */
  onSave: (value: string) => Promise<boolean>;
  /** Leave out when the value can't be removed from here: there is no remove button then. */
  onDelete?: () => unknown;
}

/** A stored value shown at a glance. Its input only exists while it is being changed, and removing it asks first. */
export function ValueRow({ label, hint, icon, url, value, placeholder, inputType = "text", onSave, onDelete }: ValueRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (draft?.trim() && (await onSave(draft.trim()))) setDraft(null);
  }

  return (
    <div>
      <SettingsRow
        icon={icon}
        hint={hint}
        value={value ?? "not set"}
        tone={value ? "secondary" : "muted"}
        label={
          <>
            <span className="truncate">{label}</span>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Get ${label} key`}
                title={`Get ${label} key`}
                className="shrink-0 inline-flex text-text-muted transition-colors hover:text-text-primary"
              >
                <ExternalLink size={16} strokeWidth={1.5} />
              </a>
            )}
          </>
        }
      >
        <RowActions>
          {confirming ? (
            <>
              <RowButton
                tone="danger"
                onClick={() => {
                  setConfirming(false);
                  onDelete?.();
                }}
              >
                Remove
              </RowButton>
              <RowButton autoFocus onClick={() => setConfirming(false)}>Keep</RowButton>
            </>
          ) : (
            <>
              <RowButton aria-expanded={draft !== null} onClick={() => setDraft(draft === null ? "" : null)}>
                {value ? "Replace" : "Add"}
              </RowButton>
              {value && onDelete ? (
                <IconButton tone="danger" label={`Remove ${label}`} onClick={() => setConfirming(true)}>
                  <X size={16} strokeWidth={1.5} />
                </IconButton>
              ) : (
                <span className="w-8 shrink-0" />
              )}
            </>
          )}
        </RowActions>
      </SettingsRow>
      {draft !== null && (
        <form
          onSubmit={submit}
          onKeyDown={(event) => event.key === "Escape" && setDraft(null)}
          className="flex gap-2 px-3 pb-3 pt-1"
        >
          <Input
            autoFocus
            aria-label={label}
            type={inputType}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder ?? "Paste value"}
            className="flex-1 min-w-0 h-8 !py-0 font-mono !text-[13px]"
          />
          <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()}>Save</Button>
          <Button size="sm" variant="outline" type="button" onClick={() => setDraft(null)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}

interface NumberSettingRowProps {
  id: string;
  label: string;
  hint?: string;
  unit?: string;
  factor?: number;
  defaultValue: number;
  stored: string | undefined;
  /** Receives the value in stored units, for example ms rather than minutes. */
  onSave: (raw: string) => Promise<unknown>;
}

/** Saves when focus leaves or on Enter. A rejected value snaps back to what is stored. */
export function NumberSettingRow({ id, label, hint, unit, factor = 1, defaultValue, stored, onSave }: NumberSettingRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = stored ? displayFromRaw(stored, factor) : "";
  const rawDefault = String(defaultValue * factor);

  async function commit() {
    if (draft !== null && draft !== shown) await onSave(draft === "" ? rawDefault : rawFromDisplay(draft, factor));
    setDraft(null);
  }

  return (
    <SettingsRow label={<label htmlFor={id}>{label}</label>} hint={hint}>
      <div className="shrink-0 flex items-center gap-2">
        <Input
          id={id}
          type="number"
          step="any"
          value={draft ?? shown}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          placeholder={String(defaultValue)}
          className="w-20 h-8 !py-0 text-right font-mono !text-[13px] tabular-nums"
        />
        <span className="w-8 font-mono text-xs text-text-muted">{unit}</span>
        <IconButton
          label={`Reset to ${defaultValue}${unit ? ` ${unit}` : ""}`}
          className={!stored || stored === rawDefault ? "invisible" : ""}
          onClick={() => onSave(rawDefault)}
        >
          <RotateCcw size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
    </SettingsRow>
  );
}
