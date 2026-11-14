// SVG-based line chart — supports multiple series, no external deps.

import { useMemo } from "react";
import CanvasCard from "./CanvasCard";
import { seriesColor } from "./colors";

interface Series {
  label: string;
  data: number[];
  color?: string;
}

interface LineChartProps {
  title?: string;
  labels?: string[];
  series: Series[];
  height?: number;
}

export default function LineChart({ title, labels, series, height = 160 }: LineChartProps) {
  const padding = { top: 12, right: 12, bottom: 24, left: 40 };
  const width = 400;

  const { minY, maxY, points } = useMemo(() => {
    const allValues = series.flatMap((s) => s.data);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const range = max - min || 1;
    const padded = { min: min - range * 0.05, max: max + range * 0.05 };

    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const pts = series.map((s) => ({
      ...s,
      coords: s.data.map((v, i) => ({
        x: padding.left + (s.data.length > 1 ? (i / (s.data.length - 1)) * chartW : chartW / 2),
        y: padding.top + chartH - ((v - padded.min) / (padded.max - padded.min)) * chartH,
      })),
    }));

    return { minY: padded.min, maxY: padded.max, points: pts };
  }, [series, height]);

  const chartH = height - padding.top - padding.bottom;
  const ticks = 4;

  return (
    <CanvasCard title={title}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const y = padding.top + (i / ticks) * chartH;
          const val = maxY - (i / ticks) * (maxY - minY);
          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                className={i === ticks ? "stroke-white/12" : "stroke-white/6"}
                strokeWidth={1}
              />
              <text x={padding.left - 6} y={y + 4} textAnchor="end" className="fill-text-muted font-mono" fontSize={11}>
                {Number.isInteger(val) ? val : val.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {labels?.map((label, i) => {
          const x = padding.left + (labels.length > 1 ? (i / (labels.length - 1)) * (width - padding.left - padding.right) : (width - padding.left - padding.right) / 2);
          return (
            <text key={i} x={x} y={height - 4} textAnchor="middle" className="fill-text-muted font-mono" fontSize={11}>
              {label}
            </text>
          );
        })}

        {/* Lines + dots */}
        {points.map((s, si) => {
          const color = s.color ?? seriesColor(si);
          const pathD = s.coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
          return (
            <g key={si}>
              <polyline
                points={s.coords.map((c) => `${c.x},${c.y}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={si === 0 ? 2 : 1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Only the leading series gets an area fill, so overlapping series stay readable */}
              {si === 0 && (
                <path
                  d={`${pathD} L ${s.coords[s.coords.length - 1].x} ${padding.top + chartH} L ${s.coords[0].x} ${padding.top + chartH} Z`}
                  fill={color}
                  fillOpacity={0.12}
                />
              )}
              {s.coords.map((c, ci) => (
                <circle key={ci} cx={c.x} cy={c.y} r={2} fill={color} />
              ))}
            </g>
          );
        })}
      </svg>

      {series.length > 1 && (
        <div className="flex flex-wrap gap-4 mt-2">
          {series.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="size-2 rounded-full" style={{ backgroundColor: s.color ?? seriesColor(i) }} />
              <span className="text-xs text-text-secondary">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </CanvasCard>
  );
}
