import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface CurveSeries {
  key: string;
  label: string;
  color: string;
  data: number[];
  /** Soft fade under the line, and the end dot. For the series the chart is about. */
  lead?: boolean;
  /** Starts switched off, for a series whose scale would flatten the others. */
  hidden?: boolean;
}

interface CurveChartProps {
  label: string;
  ticks: string[];
  /** Fuller x labels for the hover card. Defaults to the ticks. */
  tips?: string[];
  series: CurveSeries[];
  /** Fixed plot height. Without it the plot fills its flex parent, within limits. */
  height?: number;
  /** Fixes the top of the scale, for shares. */
  max?: number;
  unit?: string;
}

const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 24;
const MIN_TICK_GAP = 60;

export function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Monotone cubic through the points: smooth, but a curve never peaks above or dips below its data. */
export function smoothPath(points: [number, number][]): string {
  const slope = (i: number) => {
    const [x, y] = points[i];
    const before = points[i - 1] && (y - points[i - 1][1]) / (x - points[i - 1][0]);
    const after = points[i + 1] && (points[i + 1][1] - y) / (points[i + 1][0] - x);
    if (before === undefined) return after ?? 0;
    if (after === undefined) return before;
    if (before * after <= 0) return 0;
    return Math.sign(before) * Math.min(Math.abs(before + after) / 2, 3 * Math.abs(before), 3 * Math.abs(after));
  };
  return points.reduce((d, [x, y], i) => {
    if (i === 0) return `M${x} ${y}`;
    const [x0, y0] = points[i - 1];
    const dx = (x - x0) / 3;
    return `${d} C${x0 + dx} ${y0 + slope(i - 1) * dx} ${x - dx} ${y - slope(i) * dx} ${x} ${y}`;
  }, "");
}

const formatValue = (value: number, unit = "") => `${Math.round(value).toLocaleString("en-GB")}${unit}`;

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-text-secondary leading-snug mt-0 mb-4 [&_b]:font-medium [&_b]:text-text-primary">{children}</p>;
}

export function CurveChart({ label, ticks, tips = ticks, series, height: fixedHeight, max: fixedMax, unit }: CurveChartProps) {
  const [ref, { width, height: measured }] = useSize();
  const height = fixedHeight ?? measured;
  const gradientId = useId().replace(/:/g, "");
  const [off, setOff] = useState(() => new Set(series.filter((s) => s.hidden).map((s) => s.key)));
  const [hover, setHover] = useState<number | null>(null);

  const visible = series.filter((s) => !off.has(s.key));
  const max = fixedMax ?? Math.max(4, ...visible.flatMap((s) => s.data));
  const padLeft = formatValue(max, unit).length * 7 + 10;
  const count = ticks.length;
  const step = count > 1 ? (width - padLeft - PAD_RIGHT) / (count - 1) : 0;
  const baseline = height - PAD_BOTTOM;
  const x = (i: number) => padLeft + i * step;
  const y = (value: number) => baseline - (value / max) * (baseline - PAD_TOP);
  const every = Math.max(1, Math.ceil(MIN_TICK_GAP / (step || 1)));
  const lastGetsTick = ((count - 1) % every) * step === 0 || ((count - 1) % every) * step >= MIN_TICK_GAP * 0.75;
  const hoverLeft = hover !== null && x(hover) < width / 2;

  const toggle = (key: string) =>
    setOff((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col flex-1 min-w-0">
      {series.length > 1 && (
        <div className="flex flex-wrap justify-end gap-x-1 gap-y-1 mb-2 -mr-1.5">
          {series.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={!off.has(s.key)}
              onClick={() => toggle(s.key)}
              className={`flex items-center gap-1.5 h-6 px-1.5 rounded-md bg-transparent border-0 cursor-pointer font-mono text-xs transition-colors hover:bg-raised ${off.has(s.key) ? "text-text-muted/50 line-through" : "text-text-muted"}`}
            >
              <i className={`w-3 h-0.5 rounded-sm ${off.has(s.key) ? "opacity-30" : ""}`} style={{ backgroundColor: s.color }} />
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div ref={ref} className={`relative ${fixedHeight ? "" : "flex-1 min-h-60 max-h-[540px]"}`} style={fixedHeight ? { height: fixedHeight } : undefined}>
        {width > 0 && height > 0 && count > 0 && (
          <svg
            width={width}
            height={height}
            className="absolute inset-0 block touch-pan-y"
            role="img"
            aria-label={label}
            onPointerMove={(e) => {
              const left = e.currentTarget.getBoundingClientRect().left;
              setHover(Math.max(0, Math.min(count - 1, Math.round((e.clientX - left - padLeft) / (step || 1)))));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              {visible.filter((s) => s.lead).map((s) => (
                <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={s.color} stopOpacity="0.16" />
                  <stop offset="1" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>
            {[0, Math.round(max / 2), max].map((tick) => (
              <g key={tick}>
                <line x1={padLeft} x2={width - PAD_RIGHT} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "stroke-white/12" : "stroke-white/6"} />
                <text x={0} y={y(tick) + 4} className="fill-text-muted font-mono text-[11px]">{formatValue(tick, unit)}</text>
              </g>
            ))}
            {ticks.map((tick, i) => {
              const last = i === count - 1;
              if (last ? !lastGetsTick : i % every !== 0) return null;
              return (
                <text key={i} x={x(i)} y={height - 4} textAnchor={last ? "end" : i === 0 ? "start" : "middle"} className="fill-text-muted font-mono text-[11px]">
                  {tick}
                </text>
              );
            })}
            {/* The lead series goes on top, so it stays readable where the lines share a baseline. */}
            {[...visible].sort((a, b) => Number(a.lead ?? false) - Number(b.lead ?? false)).map((s) => {
              const points = s.data.map((value, i): [number, number] => [x(i), y(value)]);
              const line = smoothPath(points);
              const end = points[points.length - 1];
              return (
                <g key={s.key}>
                  {s.lead && <path d={`${line} L${end[0]} ${baseline} L${padLeft} ${baseline} Z`} fill={`url(#${gradientId}-${s.key})`} />}
                  <path d={line} fill="none" stroke={s.color} strokeWidth={s.lead ? 2 : 1.5} strokeLinejoin="round" />
                  {s.lead && hover === null && <circle cx={end[0]} cy={end[1]} r={3.5} fill={s.color} />}
                </g>
              );
            })}
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={baseline} className="stroke-white/20" />
                {visible.map((s) => (
                  <circle key={s.key} cx={x(hover)} cy={y(s.data[hover])} r={3.5} fill={s.color} className="stroke-glass" strokeWidth={2} />
                ))}
              </g>
            )}
          </svg>
        )}
        {hover !== null && width > 0 && (
          <div
            className="absolute top-0 z-10 pointer-events-none rounded-md border border-glass-border bg-raised px-2.5 py-2 font-mono text-xs whitespace-nowrap"
            style={hoverLeft ? { left: x(hover) + 12 } : { right: width - x(hover) + 12 }}
          >
            <div className="text-text-muted mb-1">{tips[hover]}</div>
            {visible.map((s) => (
              <div key={s.key} className="flex items-center gap-2 h-5 text-text-secondary">
                <i className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}
                <span className="ml-auto pl-4 text-text-primary tabular-nums">{formatValue(s.data[hover], unit)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A tile's trend: the same curve and fade, with no axes. `max` fixes the top of the scale, for shares; without it the curve fills the height. */
export function SparkCurve({ values, color = "#f2a33a", max }: { values: number[]; color?: string; max?: number }) {
  const gradientId = useId().replace(/:/g, "");
  if (values.length < 2) return <div className="h-8" />;
  const W = 240;
  const H = 32;
  const top = max ?? Math.max(...values);
  const low = Math.min(0, ...values);
  const points = values.map((v, i): [number, number] => [(i / (values.length - 1)) * W, H - 2 - ((Math.min(v, top) - low) / (top - low || 1)) * (H - 4)]);
  const line = smoothPath(points);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-8" aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.16" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
