// Simple bar chart — pure CSS, no charting library needed.

import CanvasCard from "./CanvasCard";
import { hue } from "./colors";

interface BarChartProps {
  title?: string;
  bars: { label: string; value: number; color?: string }[];
}

export default function BarChart({ title, bars }: BarChartProps) {
  const maxVal = Math.max(...bars.map((b) => b.value), 1);

  return (
    <CanvasCard title={title}>
      <div className="flex flex-col gap-3">
        {bars.map((bar, i) => {
          const pct = Math.round((bar.value / maxVal) * 100);
          return (
            <div key={i}>
              <div className="flex items-baseline justify-between gap-3 mb-1.5">
                <span className="text-[13px] text-text-secondary truncate">{bar.label}</span>
                <span className="font-mono text-xs text-text-muted tabular-nums">{bar.value}</span>
              </div>
              <div className="w-full h-1.5 bg-raised rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, backgroundColor: hue(bar.color) }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </CanvasCard>
  );
}
