import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";
import { Keyboard } from "lucide-react";
import type { PreviewClientMessage, PreviewElement, PreviewMouseButton } from "@chomp/shared";
import type { AgentMark, PreviewFrame } from "../../hooks/usePreviewStream";
import { fitFrame, modifierMask, pagePoint, pressedKey, wheelPixels, type Size } from "../../lib/preview";
import { pipKind } from "../../lib/pip";
import { IconButton } from "../ui";
import PreviewPicker from "./PreviewPicker";

const PANE_SETTLE_MS = 120;
const MOVE_INTERVAL_MS = 16;
const TAP_SLOP_PX = 6;
const MULTI_CLICK_MS = 400;
const BUTTONS: PreviewMouseButton[] = ["left", "middle", "right"];
const ACTION_LABELS: Record<string, string> = { double_click: "double-click", right_click: "right-click" };

interface Touch {
  id: number;
  start: { x: number; y: number };
  last: { x: number; y: number };
  scrolling: boolean;
}

/**
 * The host's page, drawn from its frames, with the user's pointer, wheel and keys sent back.
 * A touch drag scrolls and a tap clicks. Keys go through a hidden textarea, so phone keyboards and IME work.
 */
export default function PreviewScreen({ send, onFrame, agentMark, touchDevice, video, picking, inspect, onMark, onPickDone }: {
  send: (message: PreviewClientMessage) => void;
  onFrame: (listener: ((frame: PreviewFrame) => void) | null) => void;
  agentMark: AgentMark | null;
  touchDevice: boolean;
  /** Where video PiP is the fallback, a video of this screen, for the window's pop-out button. */
  video: RefObject<HTMLVideoElement | null>;
  /** While true, the pointer picks an element to comment on instead of using the page. */
  picking: boolean;
  inspect: (x: number, y: number, crop: boolean) => Promise<PreviewElement | null>;
  onMark: (element: PreviewElement, comment: string) => void;
  onPickDone: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const touch = useRef<Touch | null>(null);
  const lastMove = useRef(0);
  const clicks = useRef({ at: 0, x: 0, y: 0, count: 0 });
  const [pane, setPane] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  const shown = pane && frame ? fitFrame(frame, pane) : null;

  // The host sizes a desktop page to this pane, so it follows every resize once the drag settles.
  // Measured in the pane's own window, which is a separate one when it is popped out.
  useEffect(() => {
    const el = box.current!;
    const view = el.ownerDocument.defaultView ?? window;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new view.ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      setPane({ width, height });
      clearTimeout(settle);
      settle = setTimeout(() => {
        const dark = view.matchMedia("(prefers-color-scheme: dark)").matches;
        send({ type: "pane", width: Math.round(width), height: Math.round(height), dpr: view.devicePixelRatio || 1, dark });
      }, PANE_SETTLE_MS);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
    };
  }, [send]);

  // Draws the newest frame only: a frame that arrives while one decodes replaces any still waiting.
  useEffect(() => {
    let waiting: PreviewFrame | null = null;
    let drawing = false;
    const draw = async () => {
      drawing = true;
      while (waiting) {
        const next = waiting;
        waiting = null;
        const bitmap = await createImageBitmap(next.jpeg).catch(() => null);
        const el = canvas.current;
        if (!bitmap || !el) continue;
        if (el.width !== bitmap.width || el.height !== bitmap.height) Object.assign(el, { width: bitmap.width, height: bitmap.height });
        el.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
      drawing = false;
    };
    onFrame((next) => {
      waiting = next;
      setFrame((current) => (current?.width === next.width && current.height === next.height ? current : { width: next.width, height: next.height }));
      if (!drawing) void draw();
    });
    return () => onFrame(null);
  }, [onFrame]);

  // A muted video of the canvas, playing already, so a click can put it in PiP within the gesture.
  useEffect(() => {
    const el = video.current;
    if (pipKind !== "video" || !el || !canvas.current) return;
    el.srcObject = canvas.current.captureStream();
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [video]);

  const toPage = (e: { clientX: number; clientY: number }) => pagePoint({ x: e.clientX, y: e.clientY }, canvas.current!.getBoundingClientRect(), frame!);

  const mouse = (event: "down" | "up" | "move", e: PointerEvent<HTMLCanvasElement>, button: PreviewMouseButton, clickCount: number) => {
    send({ type: "mouse", event, ...toPage(e), button, clickCount, modifiers: modifierMask(e) });
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!frame) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch") {
      const at = { x: e.clientX, y: e.clientY };
      touch.current = { id: e.pointerId, start: at, last: at, scrolling: false };
      return;
    }
    keys.current?.focus({ preventScroll: true });
    const c = clicks.current;
    const again = e.timeStamp - c.at < MULTI_CLICK_MS && Math.hypot(e.clientX - c.x, e.clientY - c.y) < TAP_SLOP_PX;
    clicks.current = { at: e.timeStamp, x: e.clientX, y: e.clientY, count: again ? Math.min(c.count + 1, 3) : 1 };
    mouse("down", e, BUTTONS[e.button] ?? "left", clicks.current.count);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!frame) return;
    const t = touch.current;
    if (e.pointerType === "touch") {
      if (!t || t.id !== e.pointerId) return;
      if (!t.scrolling && Math.hypot(e.clientX - t.start.x, e.clientY - t.start.y) < TAP_SLOP_PX) return;
      t.scrolling = true;
      // A finger drags the page, so the content moves with it: the opposite of a wheel's delta.
      const scale = frame.width / e.currentTarget.getBoundingClientRect().width;
      send({ type: "wheel", ...toPage({ clientX: t.start.x, clientY: t.start.y }), dx: (t.last.x - e.clientX) * scale, dy: (t.last.y - e.clientY) * scale });
      t.last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.timeStamp - lastMove.current < MOVE_INTERVAL_MS) return;
    lastMove.current = e.timeStamp;
    const held = BUTTONS.find((_, i) => e.buttons & [1, 4, 2][i]) ?? "none";
    mouse("move", e, held, 0);
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!frame) return;
    const t = touch.current;
    if (e.pointerType === "touch") {
      touch.current = null;
      if (!t || t.scrolling) return;
      mouse("down", e, "left", 1);
      mouse("up", e, "left", 1);
      return;
    }
    mouse("up", e, BUTTONS[e.button] ?? "left", clicks.current.count);
  };

  const onWheel = (e: WheelEvent<HTMLElement>) => {
    if (!frame) return;
    send({ type: "wheel", ...toPage(e), dx: wheelPixels(e.deltaX, e.deltaMode), dy: wheelPixels(e.deltaY, e.deltaMode) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const key = pressedKey(e);
    if (!key) return;
    e.preventDefault();
    send({ type: "press", key });
  };

  // The textarea is only a funnel: whatever lands in it goes to the page, and it empties again.
  const flush = (el: HTMLTextAreaElement) => {
    if (el.value) send({ type: "text", text: el.value });
    el.value = "";
  };

  const mark = agentMark && frame && agentMark.x !== null && agentMark.y !== null ? agentMark : null;

  return (
    <div ref={box} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-surface-alt">
      <div className="relative" style={shown ?? { width: 0, height: 0 }}>
        <canvas
          ref={canvas}
          aria-label="Preview page"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (touch.current = null)}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          className="block w-full h-full touch-none select-none bg-white"
        />
        {picking && frame && <PreviewPicker frame={frame} inspect={inspect} onWheel={onWheel} onMark={onMark} onDone={onPickDone} />}
        {mark && (
          <span
            key={mark.id}
            aria-hidden
            className="absolute w-8 h-8 rounded-full border-2 border-accent pointer-events-none animate-agent-mark"
            style={{ left: `${(mark.x! / frame!.width) * 100}%`, top: `${(mark.y! / frame!.height) * 100}%` }}
          />
        )}
        <textarea
          ref={keys}
          aria-label="Type into the preview"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onInput={(e) => !(e.nativeEvent as InputEvent).isComposing && flush(e.currentTarget)}
          onCompositionEnd={(e) => flush(e.currentTarget)}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text");
            if (text) send({ type: "text", text });
          }}
          // 16px keeps iOS from zooming the page when it focuses.
          className="absolute left-0 top-0 w-px h-px p-0 border-0 opacity-0 resize-none text-[16px] pointer-events-none"
        />
      </div>
      {pipKind === "video" && <video ref={video} muted playsInline aria-hidden className="absolute w-px h-px opacity-0 pointer-events-none" />}
      {!frame && <p className="absolute m-0 text-[13px] text-text-muted">Loading the page…</p>}
      {agentMark && (
        <span key={agentMark.id} className="absolute left-2 top-2 px-2 h-6 inline-flex items-center rounded-md bg-raised font-mono text-xs text-text-secondary pointer-events-none animate-agent-label">
          Agent: {ACTION_LABELS[agentMark.action] ?? agentMark.action}
        </span>
      )}
      {touchDevice && frame && (
        <IconButton label="Keyboard" onClick={() => keys.current?.focus({ preventScroll: true })} className="absolute left-2 bottom-2 bg-raised">
          <Keyboard size={16} strokeWidth={1.5} />
        </IconButton>
      )}
    </div>
  );
}
