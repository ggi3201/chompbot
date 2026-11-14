// Agent-friendly vector canvas for sketches, logos, and diagrams.

import { Copy, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { GlassCard, IconButton } from "../ui";

interface DrawingPath {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

interface DrawingShape {
  type: "rect" | "circle" | "ellipse" | "line" | "polygon" | "polyline";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rx?: number;
  cx?: number;
  cy?: number;
  r?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  points?: [number, number][];
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

interface DrawingLabel {
  x: number;
  y: number;
  text: string;
  size?: number;
  color?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
}

interface DrawingCanvasProps {
  title?: string;
  width?: number;
  height?: number;
  viewBox?: string;
  background?: string;
  paths?: DrawingPath[];
  shapes?: DrawingShape[];
  labels?: DrawingLabel[];
}

const DEFAULT_INK = "#ededed";
const DEFAULT_BACKGROUND = "rgba(255,255,255,0.045)";

function asFiniteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampDimension(value: number | undefined, fallback: number): number {
  return Math.max(120, Math.min(1200, asFiniteNumber(value, fallback)));
}

function normalizeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(trimmed)) return trimmed;
  if (/^rgba?\(/i.test(trimmed)) return trimmed;
  if (trimmed === "none" || trimmed === "transparent") return trimmed;
  return fallback;
}

function pointsToString(points: [number, number][] | undefined): string {
  return (points ?? [])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderShape(shape: DrawingShape, index: number) {
  const fill = normalizeColor(shape.fill, "none");
  const stroke = normalizeColor(shape.stroke, DEFAULT_INK);
  const strokeWidth = asFiniteNumber(shape.strokeWidth, 2);
  const opacity = asFiniteNumber(shape.opacity, 1);

  switch (shape.type) {
    case "rect":
      return (
        <rect
          key={index}
          x={asFiniteNumber(shape.x, 0)}
          y={asFiniteNumber(shape.y, 0)}
          width={asFiniteNumber(shape.width, 0)}
          height={asFiniteNumber(shape.height, 0)}
          rx={asFiniteNumber(shape.rx, 0)}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
        />
      );
    case "circle":
      return (
        <circle
          key={index}
          cx={asFiniteNumber(shape.cx, 0)}
          cy={asFiniteNumber(shape.cy, 0)}
          r={asFiniteNumber(shape.r, 0)}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
        />
      );
    case "ellipse":
      return (
        <ellipse
          key={index}
          cx={asFiniteNumber(shape.cx, 0)}
          cy={asFiniteNumber(shape.cy, 0)}
          rx={asFiniteNumber(shape.width, 0) / 2}
          ry={asFiniteNumber(shape.height, 0) / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
        />
      );
    case "line":
      return (
        <line
          key={index}
          x1={asFiniteNumber(shape.x1, 0)}
          y1={asFiniteNumber(shape.y1, 0)}
          x2={asFiniteNumber(shape.x2, 0)}
          y2={asFiniteNumber(shape.y2, 0)}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeLinecap="round"
        />
      );
    case "polygon":
      return (
        <polygon
          key={index}
          points={pointsToString(shape.points)}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeLinejoin="round"
        />
      );
    case "polyline":
      return (
        <polyline
          key={index}
          points={pointsToString(shape.points)}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          opacity={opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    default:
      return null;
  }
}

function buildSvgMarkup({
  width,
  height,
  viewBox,
  background,
  paths,
  shapes,
  labels,
}: Required<Pick<DrawingCanvasProps, "width" | "height" | "viewBox" | "background" | "paths" | "shapes" | "labels">>) {
  const pathMarkup = paths
    .map((path) => {
      const fill = normalizeColor(path.fill, "none");
      const stroke = normalizeColor(path.stroke, fill === "none" ? DEFAULT_INK : "none");
      const strokeWidth = asFiniteNumber(path.strokeWidth, 2);
      const opacity = asFiniteNumber(path.opacity, 1);
      return `<path d="${escapeSvg(path.d)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  const shapeMarkup = shapes
    .map((shape) => {
      const fill = normalizeColor(shape.fill, "none");
      const stroke = normalizeColor(shape.stroke, DEFAULT_INK);
      const strokeWidth = asFiniteNumber(shape.strokeWidth, 2);
      const opacity = asFiniteNumber(shape.opacity, 1);
      if (shape.type === "rect") return `<rect x="${asFiniteNumber(shape.x, 0)}" y="${asFiniteNumber(shape.y, 0)}" width="${asFiniteNumber(shape.width, 0)}" height="${asFiniteNumber(shape.height, 0)}" rx="${asFiniteNumber(shape.rx, 0)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
      if (shape.type === "circle") return `<circle cx="${asFiniteNumber(shape.cx, 0)}" cy="${asFiniteNumber(shape.cy, 0)}" r="${asFiniteNumber(shape.r, 0)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
      if (shape.type === "ellipse") return `<ellipse cx="${asFiniteNumber(shape.cx, 0)}" cy="${asFiniteNumber(shape.cy, 0)}" rx="${asFiniteNumber(shape.width, 0) / 2}" ry="${asFiniteNumber(shape.height, 0) / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
      if (shape.type === "line") return `<line x1="${asFiniteNumber(shape.x1, 0)}" y1="${asFiniteNumber(shape.y1, 0)}" x2="${asFiniteNumber(shape.x2, 0)}" y2="${asFiniteNumber(shape.y2, 0)}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linecap="round"/>`;
      const points = pointsToString(shape.points);
      if (shape.type === "polygon") return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linejoin="round"/>`;
      if (shape.type === "polyline") return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return "";
    })
    .join("");
  const labelMarkup = labels
    .map((label) => `<text x="${label.x}" y="${label.y}" fill="${normalizeColor(label.color, DEFAULT_INK)}" font-size="${asFiniteNumber(label.size, 14)}" font-weight="${asFiniteNumber(label.weight, 600)}" text-anchor="${label.anchor ?? "start"}">${escapeSvg(label.text)}</text>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}"><rect width="100%" height="100%" fill="${background}"/>${pathMarkup}${shapeMarkup}${labelMarkup}</svg>`;
}

export default function DrawingCanvas({
  title,
  width: rawWidth,
  height: rawHeight,
  viewBox,
  background,
  paths = [],
  shapes = [],
  labels = [],
}: DrawingCanvasProps) {
  const [copied, setCopied] = useState(false);
  const width = clampDimension(rawWidth, 640);
  const height = clampDimension(rawHeight, 360);
  const safeViewBox = viewBox || `0 0 ${width} ${height}`;
  const safeBackground = normalizeColor(background, DEFAULT_BACKGROUND);
  const svgMarkup = useMemo(
    () => buildSvgMarkup({ width, height, viewBox: safeViewBox, background: safeBackground, paths, shapes, labels }),
    [width, height, safeViewBox, safeBackground, paths, shapes, labels],
  );

  async function copySvg() {
    try {
      await navigator.clipboard.writeText(svgMarkup);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  function downloadSvg() {
    const blob = new Blob([svgMarkup], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${title ?? "drawing-canvas"}.svg`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <GlassCard className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          {title && <div className="text-[13px] text-text-secondary">{title}</div>}
          <div className="font-mono text-xs text-text-muted tabular-nums">
            {width} x {height} vector canvas
          </div>
        </div>

        <div className="flex items-center gap-1">
          <IconButton label="Copy SVG" onClick={copySvg}>
            <Copy size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton label="Download SVG" onClick={downloadSvg}>
            <Download size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-surface-alt">
        <svg
          className="block h-auto w-full"
          viewBox={safeViewBox}
          role="img"
          aria-label={title ?? "Drawing canvas"}
          style={{ background: safeBackground }}
        >
          {paths.map((path, index) => {
            const fill = normalizeColor(path.fill, "none");
            const stroke = normalizeColor(path.stroke, fill === "none" ? DEFAULT_INK : "none");
            return (
              <path
                key={index}
                d={path.d}
                fill={fill}
                stroke={stroke}
                strokeWidth={asFiniteNumber(path.strokeWidth, 2)}
                opacity={asFiniteNumber(path.opacity, 1)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          {shapes.map(renderShape)}
          {labels.map((label, index) => (
            <text
              key={index}
              x={label.x}
              y={label.y}
              fill={normalizeColor(label.color, DEFAULT_INK)}
              fontSize={asFiniteNumber(label.size, 14)}
              fontWeight={asFiniteNumber(label.weight, 600)}
              textAnchor={label.anchor ?? "start"}
            >
              {label.text}
            </text>
          ))}
        </svg>
      </div>

      <div className="flex items-center justify-between mt-2 font-mono text-xs text-text-muted">
        <span className="tabular-nums">{paths.length + shapes.length + labels.length} elements</span>
        <span>{copied ? "Copied SVG" : "Agent-friendly vectors"}</span>
      </div>
    </GlassCard>
  );
}
