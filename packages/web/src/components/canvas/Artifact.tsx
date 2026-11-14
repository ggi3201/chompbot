// An agent-written HTML page in a sandboxed iframe: inline card, full-screen expand, open in a tab.
// Without allow-same-origin the page cannot touch Chomp's token or API.

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize2, X } from "lucide-react";
import { useCanvasAction } from "./CanvasActionContext";

const SANDBOX = "allow-scripts allow-forms allow-popups";

export default function Artifact({ id, title }: { id: string; title?: string }) {
  const send = useCanvasAction();
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const src = `/api/artifacts/${id}`;

  // The page's chomp.send(text) posts here; only accept it from our own frame.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frameRef.current?.contentWindow || typeof e.data?.chompSend !== "string") return;
      send?.(e.data.chompSend);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [send]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const iconBtn = "p-1.5 rounded-sm border-none bg-transparent text-text-muted hover:text-text-primary cursor-pointer flex items-center transition-colors";

  // One iframe, restyled in place when expanded, so the page keeps its state.
  return (
    <div className={expanded ? "fixed inset-0 z-50 flex flex-col bg-base" : "rounded-lg border border-border overflow-hidden bg-glass"}>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-[13px] text-text-secondary truncate">{title || "Artifact"}</span>
        <div className="flex items-center">
          <a href={src} target="_blank" rel="noreferrer" className={iconBtn} title="Open in new tab" aria-label="Open in new tab">
            <ExternalLink size={14} strokeWidth={1.5} />
          </a>
          <button type="button" onClick={() => setExpanded((v) => !v)} className={iconBtn} title={expanded ? "Close" : "Expand"} aria-label={expanded ? "Close" : "Expand"}>
            {expanded ? <X size={14} strokeWidth={1.5} /> : <Maximize2 size={14} strokeWidth={1.5} />}
          </button>
        </div>
      </div>
      <iframe
        ref={frameRef}
        src={src}
        title={title || "Artifact"}
        sandbox={SANDBOX}
        className={`w-full border-0 bg-white ${expanded ? "flex-1" : "h-[420px]"}`}
      />
    </div>
  );
}
