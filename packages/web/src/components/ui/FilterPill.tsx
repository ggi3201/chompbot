interface FilterPillProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

/** A toggle-style filter chip; the active one steps up a surface instead of taking the accent. */
export default function FilterPill({ active, onClick, children }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-7 px-2.5 rounded-md border text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
        active
          ? "bg-raised border-white/14 text-text-primary"
          : "bg-transparent border-border text-text-muted hover:text-text-secondary hover:border-white/14"
      }`}
    >
      {children}
    </button>
  );
}
