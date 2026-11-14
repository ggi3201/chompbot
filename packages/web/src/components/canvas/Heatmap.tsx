// GitHub-contribution-style heatmap — activity tracking, habit visualization.

import CanvasCard from "./CanvasCard";
import { hue } from "./colors";

interface HeatmapProps {
  title?: string;
  data: number[]; // flat array of intensity values (0–max)
  columns?: number; // cells per row (default 7 for weekly view)
  labels?: string[]; // column headers (e.g. ["Mon","Tue",...])
  color?: string;
}

// Opacity of the block's hue for intensity levels 1–4. Level 0 is an empty neutral cell.
const LEVELS = [0.25, 0.45, 0.7, 1];
const EMPTY_CELL = "bg-white/5";

export default function Heatmap({ title, data, columns = 7, labels, color }: HeatmapProps) {
  if (!data.length) return null;

  const base = hue(color);
  const max = Math.max(...data, 1);
  const rows = Math.ceil(data.length / columns);
  const gridStyle = { gridTemplateColumns: `repeat(${columns}, 1fr)` };

  const levelOf = (value: number) => Math.min(4, Math.ceil((value / max) * 4));

  return (
    <CanvasCard title={title}>
      {labels && labels.length > 0 && (
        <div className="grid gap-1 mb-1" style={gridStyle}>
          {labels.slice(0, columns).map((l, i) => (
            <div key={i} className="font-mono text-[11px] text-text-muted text-center truncate">
              {l}
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-1" style={gridStyle}>
        {Array.from({ length: rows * columns }, (_, i) => {
          const value = data[i] ?? 0;
          if (i >= data.length) return <div key={i} className="aspect-square min-w-0" />;
          if (value <= 0) return <div key={i} className={`aspect-square rounded-xs min-w-0 ${EMPTY_CELL}`} title={`${value}`} />;
          return (
            <div
              key={i}
              className="aspect-square rounded-xs min-w-0"
              style={{ backgroundColor: base, opacity: LEVELS[levelOf(value) - 1] }}
              title={`${value}`}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-1 mt-2 justify-end">
        <span className="text-[11px] text-text-muted mr-1">Less</span>
        <div className={`size-2.5 rounded-xs ${EMPTY_CELL}`} />
        {LEVELS.map((opacity) => (
          <div key={opacity} className="size-2.5 rounded-xs" style={{ backgroundColor: base, opacity }} />
        ))}
        <span className="text-[11px] text-text-muted ml-1">More</span>
      </div>
    </CanvasCard>
  );
}
