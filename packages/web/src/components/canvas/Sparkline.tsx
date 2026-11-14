// Tiny inline SVG chart — designed to embed inside info-cards or metric grids.

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { GlassCard } from "../ui";
import { hue } from "./colors";

interface SparklineProps {
  values: number[];
  label?: string;
  color?: string;
  height?: number;
  width?: number;
}

const TRENDS = {
  1: { icon: ArrowUpRight, tone: "text-success", label: "Trending up" },
  0: { icon: ArrowRight, tone: "text-text-muted", label: "Flat" },
  [-1]: { icon: ArrowDownRight, tone: "text-error", label: "Trending down" },
} as const;

export default function Sparkline({
  values,
  label,
  color,
  height = 40,
  width = 120,
}: SparklineProps) {
  if (!values.length) return null;

  const strokeColor = hue(color);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;

  const points = values
    .map((v, i) => {
      const x = pad + (values.length > 1 ? (i / (values.length - 1)) * (width - pad * 2) : (width - pad * 2) / 2);
      const y = pad + (height - pad * 2) - ((v - min) / range) * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const lastVal = values[values.length - 1];
  const trend = TRENDS[Math.sign(lastVal - values[0]) as 1 | 0 | -1];

  return (
    <GlassCard className="px-4 py-3 inline-flex items-center gap-3">
      {label && <span className="text-[13px] text-text-secondary">{label}</span>}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <polygon
          points={`${pad},${height - pad} ${points} ${width - pad},${height - pad}`}
          fill={strokeColor}
          fillOpacity={0.12}
        />
        <polyline
          points={points}
          fill="none"
          stroke={strokeColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx={pad + (values.length > 1 ? width - pad * 2 : (width - pad * 2) / 2)}
          cy={pad + (height - pad * 2) - ((lastVal - min) / range) * (height - pad * 2)}
          r={2}
          fill={strokeColor}
        />
      </svg>
      <trend.icon size={16} strokeWidth={1.5} className={trend.tone} aria-label={trend.label} />
    </GlassCard>
  );
}
