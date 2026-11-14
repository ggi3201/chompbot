// The pencil and 3D finishes, drawn on a real canvas: both are pixel work React cannot express.

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowLeft, Download, PenLine } from "lucide-react";
import { Button } from "../ui";
import {
  PAPER,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  buildForm,
  drawPencil,
  loadImage,
  paperTooth,
  shadeForm,
  type Form,
  type SheetContent,
} from "../../lib/sketch-finish";

export type FinishKind = "pencil" | "3d";

const SIZES: Record<FinishKind, number> = { pencil: 1400, "3d": 800 };
const FRAME_BUDGET_MS = 14;
const START_SUN = { x: 0.55, y: -0.6 };

interface SketchFinishProps {
  kind: FinishKind;
  content: SheetContent;
  title: string;
  onClose: () => void;
  onDrawOn: (blob: Blob) => void;
}

export default function SketchFinish({ kind, content, title, onClose, onDrawOn }: SketchFinishProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shade = useRef<((x: number, y: number) => void) | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const width = SIZES[kind];
  const height = Math.round((width * SHEET_HEIGHT) / SHEET_WIDTH);

  useEffect(() => {
    const ctx = canvasRef.current!.getContext("2d")!;
    let frame = 0;
    let stopped = false;

    function startPencil(img: HTMLImageElement | null) {
      const graphite = document.createElement("canvas");
      graphite.width = width;
      graphite.height = height;
      const steps = drawPencil(graphite.getContext("2d")!, content, img);
      const tooth = paperTooth();
      const compose = () => {
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(graphite, 0, 0);
        ctx.fillStyle = tooth;
        ctx.fillRect(0, 0, width, height);
      };
      const tick = () => {
        const until = performance.now() + FRAME_BUDGET_MS;
        let done = false;
        while (!done && performance.now() < until) done = !!steps.next().done;
        compose();
        if (done) setBusy(false);
        else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }

    function start3d(img: HTMLImageElement | null) {
      const form: Form = buildForm(content, img, width, height);
      const image = ctx.createImageData(width, height);
      shade.current = (x, y) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          shadeForm(form, x, y, image.data);
          ctx.putImageData(image, 0, 0);
          ctx.fillStyle = "#ffe9c4";
          ctx.beginPath();
          ctx.arc(((x + 1) / 2) * width, ((y + 1) / 2) * height, 7, 0, Math.PI * 2);
          ctx.fill();
        });
      };
      shade.current(START_SUN.x, START_SUN.y);
      setBusy(false);
    }

    (content.reference ? loadImage(content.reference) : Promise.resolve(null))
      .then((img) => {
        if (stopped) return;
        if (kind === "pencil") startPencil(img);
        else start3d(img);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not finish the drawing");
        setBusy(false);
      });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      shade.current = null;
    };
  }, [kind, content, width, height]);

  function moveSun(e: PointerEvent<HTMLCanvasElement>) {
    if (kind !== "3d" || (e.type === "pointermove" && e.buttons === 0)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    shade.current?.(((e.clientX - rect.left) / rect.width) * 2 - 1, ((e.clientY - rect.top) / rect.height) * 2 - 1);
  }

  function withBlob(use: (blob: Blob) => void) {
    canvasRef.current!.toBlob((blob) => blob && use(blob), "image/png");
  }

  function download(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title} ${kind}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onPointerDown={moveSun}
        onPointerMove={moveSun}
        className={`block w-full min-h-0 rounded-md object-contain ${kind === "3d" ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft size={16} strokeWidth={1.5} /> Back to the sheet
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => withBlob(download)}>
          <Download size={16} strokeWidth={1.5} /> Download
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => withBlob(onDrawOn)}>
          <PenLine size={16} strokeWidth={1.5} /> Keep drawing on this
        </Button>
        <span className="font-mono text-xs text-text-muted ml-auto">
          {error ?? (busy ? "Drawing" : kind === "3d" ? "Drag to move the sun" : "Done")}
        </span>
      </div>
    </div>
  );
}
