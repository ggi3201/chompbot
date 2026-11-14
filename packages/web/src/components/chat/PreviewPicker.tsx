import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import type { PreviewElement } from "@chomp/shared";
import { pagePoint, type Size } from "../../lib/preview";
import { Button } from "../ui";

const HOVER_INTERVAL_MS = 80;

/**
 * A layer over the page while the user points at something: the element under the pointer is outlined,
 * a click picks it, and a bar at the bottom takes what they want to say about it. One pick per turn of the tool.
 */
export default function PreviewPicker({ frame, inspect, onWheel, onMark, onDone }: {
  frame: Size;
  inspect: (x: number, y: number, crop: boolean) => Promise<PreviewElement | null>;
  onWheel: (e: WheelEvent<HTMLElement>) => void;
  onMark: (element: PreviewElement, comment: string) => void;
  onDone: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const lastHover = useRef(0);
  const latestRequest = useRef(0);
  const [hovered, setHovered] = useState<PreviewElement | null>(null);
  const [picked, setPicked] = useState<PreviewElement | null>(null);
  const [comment, setComment] = useState("");
  const outlined = picked ?? hovered;

  // Escape steps back: from the comment to picking, from picking to the page. In the pane's own window, as it may be popped out.
  useEffect(() => {
    const view = layer.current?.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picked) setPicked(null);
      else onDone();
    };
    view.addEventListener("keydown", onKey);
    return () => view.removeEventListener("keydown", onKey);
  }, [picked, onDone]);

  const toPage = (e: PointerEvent<HTMLElement>) => pagePoint({ x: e.clientX, y: e.clientY }, e.currentTarget.getBoundingClientRect(), frame);

  // Only the newest answer counts, as answers to quick moves can arrive out of order.
  const ask = (e: PointerEvent<HTMLElement>, crop: boolean) => {
    const request = ++latestRequest.current;
    const { x, y } = toPage(e);
    return inspect(x, y, crop).then((element) => (request === latestRequest.current ? element : undefined));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (picked || e.pointerType === "touch" || e.timeStamp - lastHover.current < HOVER_INTERVAL_MS) return;
    lastHover.current = e.timeStamp;
    void ask(e, false).then((element) => element !== undefined && setHovered(element));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (picked) return;
    void ask(e, true).then((element) => {
      if (!element) return;
      setPicked(element);
      setHovered(null);
    });
  };

  const add = () => {
    if (!picked) return;
    onMark(picked, comment);
    setPicked(null);
    setComment("");
    onDone();
  };

  const pct = (n: number, of: number) => `${(n / of) * 100}%`;

  return (
    <>
      <div
        ref={layer}
        aria-label="Point at something on the page"
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerLeave={() => !picked && setHovered(null)}
        onWheel={onWheel}
        className="absolute inset-0 z-10 cursor-crosshair touch-none"
      />
      {outlined && (
        <div
          aria-hidden
          className="absolute z-10 border-2 border-accent bg-accent/10 rounded-sm pointer-events-none"
          style={{
            left: pct(outlined.box.x, frame.width),
            top: pct(outlined.box.y, frame.height),
            width: pct(outlined.box.width, frame.width),
            height: pct(outlined.box.height, frame.height),
          }}
        >
          <span className={`absolute left-0 ${outlined.box.y < 24 ? "top-full mt-1" : "bottom-full mb-1"} px-1.5 py-0.5 rounded-sm bg-accent text-on-accent font-mono text-[11px] whitespace-nowrap max-w-[240px] truncate`}>
            {outlined.label}
          </span>
        </div>
      )}
      {picked && (
        <form
          className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 p-2 border-t border-border bg-surface"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <span className="font-mono text-xs text-text-muted truncate">{picked.label}</span>
          <textarea
            autoFocus
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                add();
              }
            }}
            placeholder="What should the agent do with it?"
            className="w-full resize-none rounded-md bg-raised border border-border px-2 py-1.5 text-[16px] md:text-[13px] text-text-primary outline-none focus:border-white/24"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPicked(null)}>Pick again</Button>
            <Button type="submit" variant="primary" size="sm">Add to message</Button>
          </div>
        </form>
      )}
    </>
  );
}
