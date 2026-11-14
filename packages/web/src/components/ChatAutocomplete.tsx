import { useEffect, useRef } from "react";

export interface AutocompleteItem {
  /** Display text (e.g. "/configure" or "Claude Code") */
  label: string;
  /** Secondary text shown below the label */
  description: string;
  /** The value to insert (e.g. "/configure " or "@Claude Code ") */
  insertValue: string;
}

interface ChatAutocompleteProps {
  items: AutocompleteItem[];
  activeIndex: number;
  onSelect: (item: AutocompleteItem) => void;
}

export default function ChatAutocomplete({ items, activeIndex, onSelect }: ChatAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll active item into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const active = container.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      className="absolute bottom-full left-0 mb-2 z-30 w-full max-w-[420px] max-h-[40vh] overflow-y-auto overscroll-contain rounded-lg border border-border bg-glass shadow-modal p-1 flex flex-col"
    >
      {items.map((item, i) => (
        <button
          key={item.insertValue}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
          className={`flex items-baseline gap-3 w-full min-w-0 text-left px-2.5 py-1.5 rounded-md border-none cursor-pointer transition-colors ${
            i === activeIndex ? "bg-raised" : "bg-transparent hover:bg-raised"
          }`}
        >
          <span className="shrink-0 text-[13px] text-text-primary">{item.label}</span>
          <span className="flex-1 min-w-0 truncate text-right font-mono text-xs text-text-muted">{item.description}</span>
        </button>
      ))}
    </div>
  );
}
