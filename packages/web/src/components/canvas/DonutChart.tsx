// SVG donut/ring chart — portfolio allocation, category breakdown, budget splits.

import { useMemo } from "react";
import CanvasCard from "./CanvasCard";
import { seriesColor } from "./colors";

interface Segment {
  label: string;
  value: number;
  color?: string;
}

interface DonutChartProps {
  title?: string;
  segments: Segment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}

export default function DonutChart({
  title,
  segments,
  size = 160,
  thickness = 28,
  centerLabel,
  centerValue,
}: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  const arcs = useMemo(() => {
    const r = (size - thickness) / 2;
    const cx = size / 2;
    const cy = size / 2;
    let cumAngle = -90; // start from top

    return segments.map((seg, i) => {
      const pct = total > 0 ? seg.value / total : 0;
      const angle = pct * 360;
      const startAngle = cumAngle;
      cumAngle += angle;
      const endAngle = cumAngle;

      const startRad = (startAngle * Math.PI) / 180;
      const endRad = (endAngle * Math.PI) / 180;
      const largeArc = angle > 180 ? 1 : 0;

      const x1 = cx + r * Math.cos(startRad);
      const y1 = cy + r * Math.sin(startRad);
      const x2 = cx + r * Math.cos(endRad);
      const y2 = cy + r * Math.sin(endRad);

      // For very small segments, just skip
      if (angle < 0.5) return null;

      const d =
        angle >= 359.9
          ? // Full circle — draw two arcs
            `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`
          : `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;

      return {
        d,
        color: seg.color ?? seriesColor(i),
        label: seg.label,
        pct,
      };
    });
  }, [segments, size, thickness, total]);

  return (
    <CanvasCard title={title}>
      <div className="flex items-center gap-5">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
          {arcs.map(
            (arc, i) =>
              arc && (
                <path
                  key={i}
                  d={arc.d}
                  fill="none"
                  stroke={arc.color}
                  strokeWidth={thickness}
                />
              )
          )}
          {/* Center text */}
          {(centerValue || centerLabel) && (
            <g>
              {centerValue && (
                <text
                  x={size / 2}
                  y={centerLabel ? size / 2 - 4 : size / 2 + 4}
                  textAnchor="middle"
                  className="fill-text-primary font-medium tabular-nums"
                  fontSize={size * 0.13}
                >
                  {centerValue}
                </text>
              )}
              {centerLabel && (
                <text
                  x={size / 2}
                  y={centerValue ? size / 2 + 14 : size / 2 + 4}
                  textAnchor="middle"
                  className="fill-text-muted"
                  fontSize={Math.max(11, size * 0.07)}
                >
                  {centerLabel}
                </text>
              )}
            </g>
          )}
        </svg>

        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          {segments.map((seg, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="size-2 rounded-full shrink-0" style={{ backgroundColor: seg.color ?? seriesColor(i) }} />
              <span className="text-[13px] text-text-secondary truncate">{seg.label}</span>
              <span className="font-mono text-xs text-text-muted tabular-nums ml-auto">
                {total > 0 ? Math.round((seg.value / total) * 100) : 0}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </CanvasCard>
  );
}
