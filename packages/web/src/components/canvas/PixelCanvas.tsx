// Editable pixel grid for quick sketches, icons, and tiny diagrams.

import { Copy, Download, Eraser, Paintbrush, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, ChoicePills, GlassCard, IconButton } from "../ui";

interface Pixel {
  x: number;
  y: number;
  color: string;
}

interface PixelCanvasProps {
  title?: string;
  width?: number;
  height?: number;
  cellSize?: number;
  palette?: string[];
  initialPixels?: Pixel[];
}

const DEFAULT_PALETTE = [
  "#ffffff",
  "#111827",
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#6cb6c8",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];

const EMPTY = "transparent";
const DEFAULT_GRID_SIZE = 32;
const MAX_GRID_SIZE = 96;
const RESOLUTION_PRESETS = [16, 32, 48, 64, 96];

function clampGridSize(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(4, Math.min(MAX_GRID_SIZE, Math.floor(value as number)));
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) return trimmed;
  return null;
}

function pixelKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function buildInitialPixels(width: number, height: number, pixels: Pixel[] | undefined): Record<string, string> {
  const next: Record<string, string> = {};

  for (const pixel of pixels ?? []) {
    if (!Number.isInteger(pixel.x) || !Number.isInteger(pixel.y)) continue;
    if (pixel.x < 0 || pixel.x >= width || pixel.y < 0 || pixel.y >= height) continue;

    const color = normalizeColor(pixel.color);
    if (!color) continue;
    next[pixelKey(pixel.x, pixel.y)] = color;
  }

  return next;
}

function serializePixels(pixels: Record<string, string>): Pixel[] {
  return Object.entries(pixels).map(([key, color]) => {
    const [x, y] = key.split(":").map(Number);
    return { x, y, color };
  });
}

export default function PixelCanvas({
  title,
  width: rawWidth,
  height: rawHeight,
  cellSize: rawCellSize,
  palette: rawPalette,
  initialPixels,
}: PixelCanvasProps) {
  const initialWidth = clampGridSize(rawWidth, DEFAULT_GRID_SIZE);
  const initialHeight = clampGridSize(rawHeight, DEFAULT_GRID_SIZE);
  const cellSize = Math.max(8, Math.min(28, rawCellSize ?? 14));
  const palette = (rawPalette ?? DEFAULT_PALETTE).map(normalizeColor).filter((c): c is string => Boolean(c));
  const colors = palette.length ? palette.slice(0, 16) : DEFAULT_PALETTE;
  const [selectedColor, setSelectedColor] = useState(colors[0]);
  const [tool, setTool] = useState<"pencil" | "eraser">("pencil");
  const [isDrawing, setIsDrawing] = useState(false);
  const [gridSize, setGridSize] = useState({ width: initialWidth, height: initialHeight });
  const [pixels, setPixels] = useState(() => buildInitialPixels(initialWidth, initialHeight, initialPixels));
  const [copied, setCopied] = useState(false);
  const pixelList = useMemo(() => serializePixels(pixels), [pixels]);

  const gridTemplateColumns = `repeat(${gridSize.width}, minmax(${cellSize}px, 1fr))`;
  const exportScale = 12;

  function resizeGrid(nextSize: number) {
    setGridSize({ width: nextSize, height: nextSize });
    setPixels((current) => {
      const cropped: Record<string, string> = {};
      for (const pixel of serializePixels(current)) {
        if (pixel.x < nextSize && pixel.y < nextSize) {
          cropped[pixelKey(pixel.x, pixel.y)] = pixel.color;
        }
      }
      return cropped;
    });
  }

  function paint(x: number, y: number) {
    const key = pixelKey(x, y);
    setPixels((current) => {
      if (tool === "eraser") {
        if (!(key in current)) return current;
        const { [key]: _removed, ...rest } = current;
        return rest;
      }

      if (current[key] === selectedColor) return current;
      return { ...current, [key]: selectedColor };
    });
  }

  async function copyPixels() {
    const payload = JSON.stringify(pixelList, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  function downloadPng() {
    const canvas = document.createElement("canvas");
    canvas.width = gridSize.width * exportScale;
    canvas.height = gridSize.height * exportScale;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const pixel of pixelList) {
      ctx.fillStyle = pixel.color;
      ctx.fillRect(pixel.x * exportScale, pixel.y * exportScale, exportScale, exportScale);
    }

    const link = document.createElement("a");
    link.download = `${title ?? "pixel-canvas"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  return (
    <GlassCard className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          {title && <div className="text-[13px] text-text-secondary">{title}</div>}
          <div className="font-mono text-xs text-text-muted tabular-nums">
            {gridSize.width} x {gridSize.height} px
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={tool === "pencil" ? "ghost" : "outline"}
            className="w-8 px-0!"
            onClick={() => setTool("pencil")}
            aria-pressed={tool === "pencil"}
            title="Pencil"
            aria-label="Pencil"
          >
            <Paintbrush size={16} strokeWidth={1.5} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tool === "eraser" ? "ghost" : "outline"}
            className="w-8 px-0!"
            onClick={() => setTool("eraser")}
            aria-pressed={tool === "eraser"}
            title="Eraser"
            aria-label="Eraser"
          >
            <Eraser size={16} strokeWidth={1.5} />
          </Button>
          <IconButton label="Clear" onClick={() => setPixels({})}>
            <RotateCcw size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton label="Copy pixels" onClick={copyPixels}>
            <Copy size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton label="Download PNG" onClick={downloadPng}>
            <Download size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>

      <div className="mb-3">
        <span className="text-xs text-text-muted">Resolution</span>
        <ChoicePills
          options={RESOLUTION_PRESETS.map((size) => ({ id: String(size), label: `${size} x ${size}` }))}
          value={gridSize.width === gridSize.height ? String(gridSize.width) : ""}
          onChange={(id) => resizeGrid(Number(id))}
        />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            className={`size-6 rounded-md border border-border cursor-pointer ${
              selectedColor === color ? "ring-2 ring-text-primary ring-offset-2 ring-offset-glass" : ""
            }`}
            style={{ backgroundColor: color }}
            onClick={() => {
              setSelectedColor(color);
              setTool("pencil");
            }}
            aria-label={`Select ${color}`}
            title={color}
          />
        ))}
      </div>

      <div className="overflow-auto rounded-md border border-border bg-surface-alt p-2">
        <div
          className="grid gap-px touch-none select-none"
          style={{ gridTemplateColumns }}
          onPointerLeave={() => setIsDrawing(false)}
          onPointerUp={() => setIsDrawing(false)}
          onPointerCancel={() => setIsDrawing(false)}
        >
          {Array.from({ length: gridSize.width * gridSize.height }, (_, index) => {
            const x = index % gridSize.width;
            const y = Math.floor(index / gridSize.width);
            const color = pixels[pixelKey(x, y)] ?? EMPTY;

            return (
              <button
                key={index}
                type="button"
                className={`aspect-square min-w-0 rounded-xs border-0 cursor-crosshair ${color === EMPTY ? "bg-white/5" : ""}`}
                style={color === EMPTY ? undefined : { backgroundColor: color }}
                onPointerDown={() => {
                  setIsDrawing(true);
                  paint(x, y);
                }}
                onPointerEnter={() => {
                  if (isDrawing) paint(x, y);
                }}
                aria-label={`Pixel ${x}, ${y}`}
                title={`${x}, ${y}`}
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between mt-2 font-mono text-xs text-text-muted">
        <span className="tabular-nums">{pixelList.length} painted</span>
        <span>{copied ? "Copied pixel JSON" : "Local only"}</span>
      </div>
    </GlassCard>
  );
}
