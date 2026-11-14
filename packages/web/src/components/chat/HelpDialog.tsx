import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { AppWindow, FolderGit2, FolderTree, MapPin, Mic, PanelRight, Plus, RefreshCw, Terminal, UserRound, X, Zap } from "lucide-react";

import { HELP_GROUPS, type HelpSample } from "../../lib/help-samples";
import CanvasRenderer from "../canvas/CanvasRenderer";
import { ChoicePills } from "../ui";

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
  /** Slash commands and skills as the composer's autocomplete knows them. */
  commands: Array<{ trigger: string; label: string; description: string }>;
  /** What `@` reaches. */
  agents: Array<{ name: string; type: string }>;
  /** Puts text in the composer, so a command is one tap from being sent. */
  onInsert: (text: string) => void;
}

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
const MOD = isMac ? "⌘" : "Ctrl";

const TYPING: Array<[keys: string[], text: string]> = [
  [["/"], "Commands and skills"],
  [["@"], "An agent, a soul or another chat"],
  [["↑", "↓"], "Recall your earlier prompts"],
  [["Shift", "↵"], "New line"],
  [[MOD, "K"], "Search, jump to a page or chat"],
];

const WHILE_RUNNING: Array<[keys: string[], text: string]> = [
  [["↵"], "Add to the running task"],
  [[MOD, "↵"], "Stop it and send this instead"],
  [["Esc"], "Stop"],
];

const COMPOSER: Array<[Icon, string, string]> = [
  [Plus, "Attach", "Files and images. Pasting an image works too"],
  [Mic, "Voice", "Dictate into the box"],
  [FolderGit2, "Project", "Pick a repo before the first message; locked after"],
  [UserRound, "Soul", "Who answers: the personality this chat runs with"],
  [Zap, "Model", "Provider, model and reasoning level"],
  [MapPin, "Location", "Share where you are for this chat"],
];

const TOP_BAR: Array<[Icon, string, string]> = [
  [FolderTree, "Files", "Browse the project (chats with a project)"],
  [AppWindow, "Preview", "A live page next to the chat"],
  [Terminal, "Terminal", "A shell in this chat's folder"],
  [PanelRight, "Chat info", "Context, changed files, subagents, lineage"],
  [RefreshCw, "Refresh", "Reload this chat"],
];

// These are built into the chat; everything else in the list is a skill.
const BUILT_IN = new Set(["/handoff", "/compact", "/reload-skills", "/reload-plugins"]);

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="shrink-0 w-[92px] flex gap-1">
      {keys.map((key) => (
        <kbd key={key} className="min-w-[22px] text-center font-mono text-[11px] text-text-secondary border border-border rounded px-1.5 py-0.5 bg-raised">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-xs font-normal text-text-muted">{title}</h2>
      {children}
    </section>
  );
}

function KeyRows({ rows }: { rows: Array<[string[], string]> }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
      {rows.map(([keys, text]) => (
        <li key={text} className="flex items-center gap-3 text-[13px] text-text-secondary">
          <Keys keys={keys} />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function IconRows({ rows }: { rows: Array<[Icon, string, string]> }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-2">
      {rows.map(([Glyph, name, text]) => (
        <li key={name} className="flex items-start gap-3 text-[13px]">
          <span className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-raised text-text-secondary">
            <Glyph size={14} strokeWidth={1.5} />
          </span>
          <span className="min-w-0 pt-0.5">
            <span className="text-text-primary">{name}</span>
            <span className="text-text-muted"> · {text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const TABS = [{ id: "basics" }, ...HELP_GROUPS.map(({ id }) => ({ id }))];

/** Each component as it looks in chat. Buttons and forms are inert here: there is no chat to answer. */
function Gallery({ samples, onTry }: { samples: HelpSample[]; onTry: (ask: string) => void }) {
  return (
    <div className="flex flex-col gap-6">
      {samples.map((sample) => (
        <section key={sample.name} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="m-0 font-mono text-xs font-normal text-accent-ink">{sample.name}</h2>
            <span className="min-w-0 flex-1 text-[13px] text-text-muted">{sample.blurb}</span>
            <button
              type="button"
              onClick={() => onTry(sample.ask)}
              className="shrink-0 p-0 border-none bg-transparent text-xs text-accent-ink cursor-pointer hover:underline"
            >
              Try it
            </button>
          </div>
          {sample.block && <CanvasRenderer data={sample.block} />}
        </section>
      ))}
    </div>
  );
}

function Chip({ label, title, onClick }: { label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="font-mono text-xs px-2 py-1 rounded-md border border-border bg-transparent text-text-secondary cursor-pointer transition-colors hover:bg-raised hover:text-text-primary"
    >
      {label}
    </button>
  );
}

export default function HelpDialog({ open, onClose, commands, agents, onInsert }: HelpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("basics");

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
      // showModal focuses the first button, the close X, and draws a ring on it.
      dialogRef.current?.focus();
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  if (!open) return null;

  const builtIn = commands.filter((c) => BUILT_IN.has(c.trigger));
  const skills = commands.filter((c) => !BUILT_IN.has(c.trigger));
  const samples = HELP_GROUPS.find((group) => group.id === tab)?.samples;
  const insert = (text: string) => {
    onClose();
    onInsert(text);
  };

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && onClose()}
      className="border border-border w-full md:w-[90vw] md:max-w-[760px] h-[100dvh] md:h-[85dvh] rounded-none md:rounded-xl m-0 md:m-auto p-0 fixed inset-0 bg-glass text-text-primary shadow-modal flex flex-col outline-none"
    >
      <div className="flex items-center justify-between px-4 md:px-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 shrink-0">
        <h1 className="m-0 text-[17px] font-medium">What you can do here</h1>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 flex rounded-lg border-none bg-transparent text-text-muted cursor-pointer hover:bg-raised hover:text-text-secondary">
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>

      <div className="px-4 md:px-6 pb-3 border-b border-border shrink-0">
        <ChoicePills options={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="flex flex-col gap-6 px-4 md:px-6 py-5 overflow-y-auto pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {samples ? (
          <Gallery samples={samples} onTry={insert} />
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              <Section title="In the message box"><KeyRows rows={TYPING} /></Section>
              <Section title="While it is working"><KeyRows rows={WHILE_RUNNING} /></Section>
            </div>

            <Section title="Commands (tap one to put it in the box)">
              <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                {builtIn.map((c) => (
                  <li key={c.trigger} className="flex items-baseline gap-3 text-[13px]">
                    <button type="button" onClick={() => insert(`${c.trigger} `)} className="shrink-0 p-0 border-none bg-transparent font-mono text-xs text-accent-ink cursor-pointer hover:underline">
                      {c.trigger}
                    </button>
                    <span className="text-text-muted">{c.description}</span>
                  </li>
                ))}
                <li className="flex items-baseline gap-3 text-[13px]">
                  <span className="shrink-0 font-mono text-xs text-text-secondary">/help</span>
                  <span className="text-text-muted">This sheet</span>
                </li>
              </ul>
            </Section>

            <div className="grid gap-6 md:grid-cols-2">
              <Section title="Under the message box"><IconRows rows={COMPOSER} /></Section>
              <Section title="In the top bar"><IconRows rows={TOP_BAR} /></Section>
            </div>

            {skills.length > 0 && (
              <Section title={`Skills (${skills.length})`}>
                <div className="flex flex-wrap gap-1.5">
                  {skills.map((s) => <Chip key={s.trigger} label={s.trigger} title={s.description} onClick={() => insert(`${s.trigger} `)} />)}
                </div>
              </Section>
            )}

            {agents.length > 0 && (
              <Section title="Who @ reaches">
                <div className="flex flex-wrap gap-1.5">
                  {agents.map((a) => <Chip key={a.name} label={`@${a.name}`} title={a.type} onClick={() => insert(`@${a.name} `)} />)}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
