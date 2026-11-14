// SVG radar/spider chart — skill comparison, multi-dimensional analysis.

import { useMemo } from "react";
import CanvasCard from "./CanvasCard";
import { seriesColor } from "./colors";

interface RadarDataset {
  label: string;
  values: number[];
  color?: string;
}

interface RadarChartProps {
  title?: string;
  axes: string[];
  datasets: RadarDataset[];
  max?: number;
  size?: number;
}

export default function RadarChart({ title, axes, datasets, max = 100, size = 200 }: RadarChartProps) {
  const center = size / 2;
  const radius = size / 2 - 30; // padding for labels
  const count = axes.length;

  const getPoint = (index: number, value: number) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const r = (value / max) * radius;
    return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle) };
  };

  const gridLevels = [0.2, 0.4, 0.6, 0.8, 1.0];

  const labelPositions = useMemo(
    () =>
      axes.map((_, i) => {
        const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
        const labelR = radius + 16;
        return {
          x: center + labelR * Math.cos(angle),
          y: center + labelR * Math.sin(angle),
        };
      }),
    [axes, count, center, radius]
  );

  return (
    <CanvasCard title={title}>
      <div className="flex flex-col items-center">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Grid rings */}
          {gridLevels.map((level) => {
            const points = axes
              .map((_, i) => {
                const p = getPoint(i, max * level);
                return `${p.x},${p.y}`;
              })
              .join(" ");
            return (
              <polygon
                key={level}
                points={points}
                fill="none"
                className="stroke-white/6"
                strokeWidth={1}
              />
            );
          })}

          {/* Axis lines */}
          {axes.map((_, i) => {
            const p = getPoint(i, max);
            return (
              <line
                key={i}
                x1={center}
                y1={center}
                x2={p.x}
                y2={p.y}
                className="stroke-white/6"
                strokeWidth={1}
              />
            );
          })}

          {/* Dataset polygons */}
          {datasets.map((ds, di) => {
            const color = ds.color ?? seriesColor(di);

            const points = ds.values
              .map((v, i) => {
                const p = getPoint(i, Math.min(v, max));
                return `${p.x},${p.y}`;
              })
              .join(" ");

            return (
              <g key={di}>
                <polygon
                  points={points}
                  fill={color}
                  fillOpacity={0.12}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                />
                {/* Dots at vertices */}
                {ds.values.map((v, i) => {
                  const p = getPoint(i, Math.min(v, max));
                  return <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={color} />;
                })}
              </g>
            );
          })}

          {/* Axis labels */}
          {axes.map((label, i) => (
            <text
              key={i}
              x={labelPositions[i].x}
              y={labelPositions[i].y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-text-muted"
              fontSize={11}
            >
              {label}
            </text>
          ))}
        </svg>

        {datasets.length > 1 && (
          <div className="flex flex-wrap gap-4 mt-2">
            {datasets.map((ds, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="size-2 rounded-full" style={{ backgroundColor: ds.color ?? seriesColor(i) }} />
                <span className="text-xs text-text-secondary">{ds.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </CanvasCard>
  );
}
