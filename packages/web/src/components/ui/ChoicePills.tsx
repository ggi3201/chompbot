interface ChoicePillsProps {
  options: Array<{ id: string; label?: string }>;
  value: string;
  onChange: (id: string) => void;
}

/** A row of choosable values; the selected one steps up a surface instead of taking the accent. */
export default function ChoicePills({ options, value, onChange }: ChoicePillsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          title={o.label}
          className={`h-7 px-2 rounded-md border font-mono text-xs cursor-pointer transition-colors ${
            value === o.id
              ? "bg-raised border-white/14 text-text-primary"
              : "bg-transparent border-border text-text-muted hover:text-text-secondary hover:border-white/14"
          }`}
        >
          {o.id}
        </button>
      ))}
    </div>
  );
}
