import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, PanelRight, PictureInPicture2, X } from "lucide-react";
import { IconButton } from "./ui";
import { clampRect, type PreviewRect } from "../lib/preview";

const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;
const MIN_DOCK_WIDTH = 320;
const DOCK_KEY_STEP = 24;

/** Drag with pointer capture, which keeps the events here while the pointer crosses the page. */
function useDrag(onMove: (dx: number, dy: number) => void) {
  const last = useRef({ x: 0, y: 0 });
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest("button, a, input")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      onMove(e.clientX - last.current.x, e.clientY - last.current.y);
      last.current = { x: e.clientX, y: e.clientY };
    },
  };
}

/** The bar on a docked pane's left edge: drag it, or use the arrow keys, to change the width. `dx` is how far it moved right. */
export function DockResizeHandle({ label, onResize }: { label: string; onResize: (dx: number) => void }) {
  const drag = useDrag((dx) => onResize(dx));
  return (
    <div
      {...drag}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(-DOCK_KEY_STEP);
        if (e.key === "ArrowRight") onResize(DOCK_KEY_STEP);
      }}
      // The grab area is 8px wide; only a 2px line in its middle shows.
      className="absolute inset-y-0 -left-1 z-10 w-2 touch-none cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent"
    />
  );
}

const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });

function defaultRect(): PreviewRect {
  const width = Math.min(640, window.innerWidth - 24);
  const height = Math.min(420, Math.round(window.innerHeight * 0.55));
  return { x: window.innerWidth - width - 12, y: window.innerHeight - height - 12, width, height };
}

const frames = {
  docked: "relative h-full max-lg:max-w-[50%] lg:min-w-[320px] border-l border-border",
  floating: "fixed z-40 rounded-lg border border-border shadow-2xl overflow-hidden",
  // Sized to the visible screen, so a phone's keyboard pushes the bottom up instead of covering it.
  full: "fixed inset-x-0 top-[var(--chrome-top)] h-[calc(var(--app-height,100dvh)-var(--chrome-top))] z-50",
  // The whole of its own window, which stays on top of other apps.
  window: "fixed inset-0",
} as const;
export type PaneMode = Exclude<keyof typeof frames, "window">;

/**
 * A side pane of the chat that docks beside it, floats over it, or fills the screen.
 * A phone has no room to dock, so a docked pane floats there.
 */
export default function PaneFrame({ label, title, actions, isMobile, initialMode, modeRequest, dockWidthKey, initialRect = defaultRect, escapeExitsFull, ownWindow, frameRef, onClose, children }: {
  label: string;
  title: ReactNode;
  actions?: ReactNode;
  isMobile: boolean;
  initialMode: PaneMode;
  /** A mode asked for from outside, such as by the agent; each new id is applied once. */
  modeRequest?: { id: string; mode: PaneMode } | null;
  /** Where the docked width is remembered on this device. */
  dockWidthKey: string;
  /** Where the pane first floats. Bottom right by default. */
  initialRect?: () => PreviewRect;
  /** Escape leaves full screen. Off by default, as a terminal needs Escape itself. */
  escapeExitsFull?: boolean;
  /** A separate window, such as a picture-in-picture one, for the pane to fill instead of this tab. */
  ownWindow?: Window | null;
  /** Set to the pane's element, for a caller that measures it. */
  frameRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const [wanted, setWanted] = useState<PaneMode>(initialMode);
  const [restoreTo, setRestoreTo] = useState<PaneMode>(initialMode === "full" ? (isMobile ? "floating" : "docked") : initialMode);
  const [rect, setRect] = useState(initialRect);
  const [dockWidth, setDockWidth] = useState(() => Number(window.localStorage.getItem(dockWidthKey)) || null);
  const ownFrame = useRef<HTMLElement>(null);
  const frame = frameRef ?? ownFrame;
  const inTab: PaneMode = isMobile && wanted === "docked" ? "floating" : wanted;
  const mode = ownWindow ? "window" : inTab;
  const shown = clampRect(rect, viewportSize());

  useEffect(() => {
    if (!modeRequest) return;
    if (modeRequest.mode === "full" && inTab !== "full") setRestoreTo(inTab);
    setWanted(modeRequest.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeRequest?.id]);

  useEffect(() => {
    if (!escapeExitsFull || mode !== "full") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setWanted(restoreTo);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escapeExitsFull, mode, restoreTo]);

  const move = useDrag((dx, dy) => setRect((r) => clampRect({ ...r, x: r.x + dx, y: r.y + dy }, viewportSize())));
  const resize = useDrag((dx, dy) => setRect((r) => clampRect({ ...r, width: Math.max(MIN_WIDTH, r.width + dx), height: Math.max(MIN_HEIGHT, r.height + dy) }, viewportSize())));
  // From the rendered width, so dragging back from the max responds at once.
  const resizeDock = (dx: number) => {
    const width = Math.max(MIN_DOCK_WIDTH, (frame.current?.offsetWidth ?? 0) - dx);
    window.localStorage.setItem(dockWidthKey, String(width));
    setDockWidth(width);
  };

  const styles = {
    docked: { width: dockWidth ?? "45%" },
    floating: { left: shown.x, top: `max(${shown.y}px, var(--chrome-top))`, width: shown.width, height: shown.height, maxHeight: "calc(100dvh - var(--chrome-top))" },
    full: undefined,
    window: undefined,
  };

  const pane = (
    <section ref={frame} aria-label={label} className={`${frames[mode]} flex flex-col bg-surface`} style={styles[mode]}>
      {mode === "docked" && <DockResizeHandle label={`Resize ${label.toLowerCase()}`} onResize={resizeDock} />}
      <header
        {...(mode === "floating" ? move : {})}
        className={`flex items-center gap-1 pl-3 pr-2 border-b border-border shrink-0 select-none ${mode === "floating" ? "h-10 touch-none cursor-grab active:cursor-grabbing" : "h-12 md:h-14"}`}
      >
        <div className="flex-1 min-w-0 flex items-center gap-2">{title}</div>
        {actions}
        {!isMobile && mode === "floating" && (
          <IconButton tooltip="end" label="Dock beside the chat" onClick={() => setWanted("docked")}><PanelRight size={14} strokeWidth={1.5} /></IconButton>
        )}
        {mode === "docked" && (
          <IconButton tooltip="end" label="Float over the chat" onClick={() => setWanted("floating")}><PictureInPicture2 size={14} strokeWidth={1.5} /></IconButton>
        )}
        {mode === "full" && (
          <IconButton tooltip="end" label="Exit full screen" onClick={() => setWanted(restoreTo)}><Minimize2 size={14} strokeWidth={1.5} /></IconButton>
        )}
        {(mode === "docked" || mode === "floating") && (
          <IconButton
            tooltip="end"
            label="Full screen"
            onClick={() => {
              setRestoreTo(inTab);
              setWanted("full");
            }}
          >
            <Maximize2 size={14} strokeWidth={1.5} />
          </IconButton>
        )}
        <IconButton tooltip="end" label={`Close ${label.toLowerCase()}`} onClick={onClose}><X size={14} strokeWidth={1.5} /></IconButton>
      </header>
      {children}
      {mode === "floating" && (
        <div {...resize} aria-hidden className="absolute right-0 bottom-0 z-10 w-6 h-6 p-1 touch-none cursor-nwse-resize">
          <div className="w-full h-full border-r-2 border-b-2 border-text-muted rounded-br-sm" />
        </div>
      )}
    </section>
  );

  return ownWindow ? createPortal(pane, ownWindow.document.body) : pane;
}
