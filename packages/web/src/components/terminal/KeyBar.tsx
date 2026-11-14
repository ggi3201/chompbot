import { ClipboardPaste, TextSelect } from "lucide-react";
import { KEY_BAR, type BarKey, type Modifiers } from "../../lib/terminal/keys";

const keyStyles = {
  idle: "bg-raised text-text-primary active:bg-[#2a2a2d]",
  latched: "bg-accent text-on-accent",
} as const;

/**
 * The keys a phone keyboard lacks. Pressing one must not take focus from the terminal,
 * or iOS drops the keyboard; so the bar swallows the press and acts on click.
 */
export default function KeyBar({ modifiers, onKey, onPaste, onSelect }: {
  modifiers: Modifiers;
  onKey: (key: BarKey) => void;
  onPaste: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="flex items-center gap-1 px-2 h-12 shrink-0 border-t border-border bg-surface overflow-x-auto overscroll-x-contain [scrollbar-width:none] pb-[var(--safe-bottom)] box-content"
    >
      {KEY_BAR.map((key) => {
        const latched = "modifier" in key && modifiers[key.modifier];
        return (
          <button
            key={key.name}
            type="button"
            aria-label={key.name}
            aria-pressed={"modifier" in key ? latched : undefined}
            onClick={() => onKey(key)}
            className={`h-9 min-w-10 px-2.5 shrink-0 rounded-md border-none font-mono text-[13px] cursor-pointer transition-colors ${keyStyles[latched ? "latched" : "idle"]}`}
          >
            {key.label}
          </button>
        );
      })}
      <span aria-hidden className="w-px h-5 mx-1 shrink-0 bg-border" />
      <button type="button" aria-label="Paste" onClick={onPaste} className={`h-9 w-10 shrink-0 inline-flex items-center justify-center rounded-md border-none cursor-pointer ${keyStyles.idle}`}>
        <ClipboardPaste size={16} strokeWidth={1.5} />
      </button>
      <button type="button" aria-label="Select text" onClick={onSelect} className={`h-9 w-10 shrink-0 inline-flex items-center justify-center rounded-md border-none cursor-pointer ${keyStyles.idle}`}>
        <TextSelect size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
