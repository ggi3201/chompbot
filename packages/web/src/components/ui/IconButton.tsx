import { type ComponentPropsWithoutRef } from "react";

const tones = {
  default: "hover:text-text-primary",
  danger: "hover:text-error",
} as const;

// Which edge of the button the label lines up with, so a button near a pane's edge keeps its label inside the pane.
const tooltipEdges = {
  start: "left-0",
  end: "right-0",
} as const;

interface IconButtonProps extends ComponentPropsWithoutRef<"button"> {
  label: string;
  tone?: keyof typeof tones;
  /** Shows the label under the button on hover and keyboard focus, sooner and plainer than the browser's own title. */
  tooltip?: keyof typeof tooltipEdges;
}

/** Square ghost button holding one 16px icon. `danger` stays muted until hover, so destructive actions don't shout. */
export default function IconButton({ label, tone = "default", tooltip, className = "", children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={tooltip ? undefined : label}
      className={`inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-md bg-transparent border-none text-text-muted cursor-pointer transition-colors hover:bg-white/4 disabled:opacity-40 disabled:cursor-default ${tooltip ? "group relative" : ""} ${tones[tone]} ${className}`}
      {...props}
    >
      {children}
      {tooltip && (
        <span
          aria-hidden
          className={`absolute top-full mt-1 z-50 px-2 py-1 rounded-md border border-border bg-raised text-xs text-text-primary whitespace-nowrap pointer-events-none opacity-0 transition-opacity delay-200 group-hover:opacity-100 group-focus-visible:opacity-100 ${tooltipEdges[tooltip]}`}
        >
          {label}
        </span>
      )}
    </button>
  );
}
