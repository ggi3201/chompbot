// A sheet the user and an agent draw on in turns. Older copies in the chat stay frozen at their turn, so the
// conversation scrolls back through the drawing's history; the newest copy, or an expanded one, is the live sheet.

import { useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent } from "react";
import { Box, ImagePlus, Maximize2, Pencil, Sparkles, Undo2, X } from "lucide-react";
import { Button, IconButton, Input, LiveDot } from "../ui";
import { uploadImage, useSketch } from "../../hooks/useSketch";
import { PAPER, SHEET_HEIGHT, SHEET_WIDTH } from "../../lib/sketch-finish";
import { useCanvasAction, useCanvasLocked } from "./CanvasActionContext";
import SketchFinish, { type FinishKind } from "./SketchFinish";

const INKS = ["#2a2a2c", "#c2571a", "#1f6f8b", "#3f8f4f", "#b3325a", "#f4efe4"];
const WIDTHS = [2.5, 6, 16];
const MAX_POINTS = 700; // path data has a size limit on the server: a longer stroke continues as a new one
const MIN_STEP = 1.5;
const REFERENCE_OPACITY = 0.45;
const DRAW_MS = 450;
const DRAW_GAP_MS = 180;

type Point = [number, number];

/** A smooth path through pen samples, using the midpoints between them as anchors. */
function pointsToPath(points: Point[]): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  if (points.length < 2) return `M${f(points[0][0])} ${f(points[0][1])} L${f(points[0][0])} ${f(points[0][1])}`;
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    d += ` Q${f(points[i][0])} ${f(points[i][1])} ${f(mx)} ${f(my)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${f(last[0])} ${f(last[1])}`;
}

interface SketchpadProps {
  id: string;
  title?: string;
  upTo?: number;
}

export default function Sketchpad({ id, title, upTo }: SketchpadProps) {
  const send = useCanvasAction();
  const locked = useCanvasLocked();
  const [expanded, setExpanded] = useState(false);
  const live = send !== null && (!locked || expanded);
  const { sketch, error, addStroke, undo, setTurn, setReference } = useSketch(id, live);
  const [points, setPoints] = useState<Point[] | null>(null);
  const [ink, setInk] = useState(INKS[0]);
  const [width, setWidth] = useState(WIDTHS[0]);
  const [message, setMessage] = useState("");
  const [finish, setFinish] = useState<FinishKind | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!sketch) {
    return <div className="rounded-lg border border-border bg-glass px-3 py-2 text-[13px] text-text-muted">{error ?? "Opening the sheet"}</div>;
  }

  const myTurn = live && sketch.turn === "user";
  const waiting = live && sketch.turn === "agent";
  const marks = live ? sketch.strokes : sketch.strokes.slice(0, upTo ?? sketch.strokes.length);
  // The agent's latest marks are drawn in front of the user, one at a time.
  const lastUser = marks.map((m) => m.author).lastIndexOf("user");
  const hasUndo = myTurn && lastUser !== -1;

  function toSheet(e: PointerEvent): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    // The sheet keeps its ratio inside the element, so measure against the scale it actually got.
    const scale = Math.min(rect.width / SHEET_WIDTH, rect.height / SHEET_HEIGHT);
    const left = rect.left + (rect.width - SHEET_WIDTH * scale) / 2;
    const top = rect.top + (rect.height - SHEET_HEIGHT * scale) / 2;
    return [(e.clientX - left) / scale, (e.clientY - top) / scale];
  }

  function commit(pts: Point[]) {
    addStroke({ d: pointsToPath(pts), color: ink, width });
  }

  function penDown(e: PointerEvent<SVGSVGElement>) {
    if (!myTurn) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setPoints([toSheet(e)]);
  }

  function penMove(e: PointerEvent<SVGSVGElement>) {
    if (!points) return;
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const incoming = (samples.length ? samples : [e.nativeEvent]).map((s) => toSheet(s as unknown as PointerEvent));
    const next = [...points];
    for (const p of incoming) {
      const prev = next[next.length - 1];
      if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= MIN_STEP) next.push(p);
    }
    if (next.length >= MAX_POINTS) {
      commit(next);
      setPoints([next[next.length - 1]]);
      return;
    }
    setPoints(next);
  }

  function penUp() {
    if (!points) return;
    commit(points);
    setPoints(null);
  }

  function handOver(prompt: string) {
    const text = message.trim();
    setMessage("");
    // Saved first, so the agent's read can't overtake the handover or the strokes queued before it.
    setTurn("agent").then(() => send?.(`[Sketch ${id}] ${prompt}${text ? ` ${text}` : ""}`));
  }

  function yourGo(e: FormEvent) {
    e.preventDefault();
    handOver("Your go.");
  }

  async function useAsReference(blob: Blob, name: string) {
    try {
      setUploadError(null);
      await setReference(await uploadImage(blob, name));
      setFinish(null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Could not use that image");
    }
  }

  function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) useAsReference(file, file.name);
    e.target.value = "";
  }

  return (
    <div className={expanded ? "fixed inset-0 z-50 flex flex-col gap-2 bg-surface p-3" : "flex flex-col gap-2 rounded-lg border border-border bg-glass p-3"}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-text-secondary truncate">{title || sketch.title}</span>
        <IconButton label={expanded ? "Close" : "Expand"} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <X size={16} strokeWidth={1.5} /> : <Maximize2 size={16} strokeWidth={1.5} />}
        </IconButton>
      </div>

      {finish ? (
        <SketchFinish
          kind={finish}
          content={{ reference: sketch.reference, strokes: marks }}
          title={title || sketch.title}
          onClose={() => setFinish(null)}
          onDrawOn={(blob) => useAsReference(blob, `${finish}.png`)}
        />
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}`}
            role="img"
            aria-label={`Drawing sheet: ${title || sketch.title}`}
            onPointerDown={penDown}
            onPointerMove={penMove}
            onPointerUp={penUp}
            onPointerCancel={penUp}
            className={`block w-full rounded-md select-none ${expanded ? "flex-1 min-h-0" : "h-auto"} ${myTurn ? "touch-none cursor-crosshair" : ""}`}
          >
            <rect width={SHEET_WIDTH} height={SHEET_HEIGHT} fill={PAPER} />
            {sketch.reference && (
              <image href={sketch.reference} width={SHEET_WIDTH} height={SHEET_HEIGHT} opacity={REFERENCE_OPACITY} preserveAspectRatio="xMidYMid meet" />
            )}
            {marks.map((m, i) => {
              const fresh = live && m.author === "agent" && i > lastUser;
              return (
                <path
                  key={i}
                  d={m.d}
                  fill={m.fill ?? "none"}
                  stroke={m.color}
                  strokeWidth={m.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  {...(fresh
                    ? {
                        pathLength: 1,
                        strokeDasharray: 1,
                        className: "motion-safe:animate-[sketch-draw_var(--draw-ms)_ease-out_both]",
                        style: { "--draw-ms": `${DRAW_MS}ms`, animationDelay: `${(i - lastUser - 1) * DRAW_GAP_MS}ms` } as React.CSSProperties,
                      }
                    : {})}
                />
              );
            })}
            {points && <path d={pointsToPath(points)} fill="none" stroke={ink} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
          </svg>

          {sketch.note && live && <p className="m-0 text-sm text-text-primary">{sketch.note}</p>}

          {myTurn && (
            <div className="flex flex-wrap items-center gap-1">
              {INKS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Ink ${c}`}
                  aria-pressed={ink === c}
                  onClick={() => setInk(c)}
                  className={`w-8 h-8 flex items-center justify-center rounded-md border-none cursor-pointer transition-colors ${ink === c ? "bg-raised" : "bg-transparent"}`}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <circle cx="9" cy="9" r="7" fill={c} stroke="currentColor" strokeOpacity="0.25" />
                  </svg>
                </button>
              ))}
              <span className="w-px h-5 bg-border mx-1" />
              {WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-label={`Pen width ${w}`}
                  aria-pressed={width === w}
                  onClick={() => setWidth(w)}
                  className={`w-8 h-8 flex items-center justify-center rounded-md border-none cursor-pointer text-text-secondary transition-colors ${width === w ? "bg-raised" : "bg-transparent"}`}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <circle cx="9" cy="9" r={Math.min(8, 1 + w / 2)} fill="currentColor" />
                  </svg>
                </button>
              ))}
              <span className="w-px h-5 bg-border mx-1" />
              <IconButton label="Undo my last stroke" disabled={!hasUndo} onClick={undo}>
                <Undo2 size={16} strokeWidth={1.5} />
              </IconButton>
              <IconButton label="Put an image under the sheet" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={16} strokeWidth={1.5} />
              </IconButton>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
            </div>
          )}

          {myTurn && (
            <form onSubmit={yourGo} className="flex gap-2">
              <Input
                value={message}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMessage(e.target.value)}
                placeholder="Tell it what you're after (optional)"
                aria-label="Message with your turn"
                className="flex-1 min-w-0"
              />
              <Button type="submit" variant="primary" size="sm">
                Your go
              </Button>
            </form>
          )}

          {waiting && (
            <div className="flex items-center gap-2 text-[13px] text-text-secondary">
              <LiveDot />
              <span>Its turn. It looks at the sheet first, so give it a moment.</span>
              <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setTurn("user")}>
                Take the pen back
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-text-muted mr-1">Finish as</span>
            <Button type="button" variant="ghost" size="sm" disabled={!marks.length && !sketch.reference} onClick={() => setFinish("pencil")}>
              <Pencil size={16} strokeWidth={1.5} /> Pencil
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!marks.length && !sketch.reference} onClick={() => setFinish("3d")}>
              <Box size={16} strokeWidth={1.5} /> 3D
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!myTurn || (!marks.length && !sketch.reference)}
              onClick={() => handOver("Turn this sheet into an AI image, keeping the composition.")}
            >
              <Sparkles size={16} strokeWidth={1.5} /> AI image
            </Button>
          </div>
        </>
      )}

      {(error || uploadError) && <p className="m-0 text-xs text-error">{error ?? uploadError}</p>}
    </div>
  );
}
