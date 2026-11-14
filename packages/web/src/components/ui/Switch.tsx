interface SwitchProps {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}

/** An on/off switch. The invisible ::before widens the touch target past the 20px track. */
export default function Switch({ on, label, onChange, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative shrink-0 h-5 w-9 rounded-full border cursor-pointer transition-colors duration-150 before:absolute before:-inset-2 disabled:opacity-50 disabled:cursor-default ${
        on ? "bg-accent border-transparent" : "bg-raised border-border"
      }`}
    >
      <span className={`absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full transition-transform duration-150 ${on ? "translate-x-4 bg-on-accent" : "bg-text-muted"}`} />
    </button>
  );
}
