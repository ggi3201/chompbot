// Progress bar — for task progress, quotas, completion indicators.

import CanvasCard from "./CanvasCard";
import { hue } from "./colors";

interface ProgressBarProps {
  label: string;
  value: number;
  max?: number;
  color?: string;
  showPercent?: boolean;
}

export default function ProgressBar({ label, value, max = 100, color, showPercent = true }: ProgressBarProps) {
  const pct = Math.min(100, Math.round((value / max) * 100));

  return (
    <CanvasCard>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-[13px] text-text-secondary">{label}</span>
        {showPercent && <span className="font-mono text-xs text-text-muted tabular-nums">{pct}%</span>}
      </div>
      <div className="w-full h-1.5 bg-raised rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: hue(color) }} />
      </div>
    </CanvasCard>
  );
}
