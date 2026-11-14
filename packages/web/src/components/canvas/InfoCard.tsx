// Single stat card — title, value, optional subtitle/change/color.

import { GlassCard } from "../ui";

interface InfoCardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: string;
  color?: string;
}

// The card stays neutral. A named color only tints the figure, and only where it reads as good, bad or warning.
const FIGURE_TONES: Record<string, string> = {
  emerald: "text-success",
  pink: "text-error",
  amber: "text-accent-ink",
};

const CHANGE_TONES: Record<string, string> = {
  "+": "text-success",
  "-": "text-error",
};

export default function InfoCard({ title, value, subtitle, change, color }: InfoCardProps) {
  const figureTone = FIGURE_TONES[color ?? ""] ?? "text-text-primary";
  const changeTone = CHANGE_TONES[change?.[0] ?? ""] ?? "text-text-muted";

  return (
    <GlassCard className="px-4 py-3 min-w-0">
      <div className="text-[13px] text-text-secondary mb-1 truncate">{title}</div>
      <div className={`text-2xl leading-tight font-medium tabular-nums ${figureTone}`}>{value}</div>
      {(change || subtitle) && (
        <div className="flex items-baseline gap-2 mt-1.5">
          {change && <span className={`font-mono text-xs tabular-nums ${changeTone}`}>{change}</span>}
          {subtitle && <span className="text-xs text-text-muted truncate">{subtitle}</span>}
        </div>
      )}
    </GlassCard>
  );
}
