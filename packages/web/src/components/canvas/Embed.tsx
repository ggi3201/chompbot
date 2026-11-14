// A live page from an allowlisted origin (e.g. the login booth's noVNC) in a plain iframe.
// Artifacts can't do this: their sandbox is inherited by nested frames, which breaks noVNC.
// allow-same-origin is safe here only because every allowed origin differs from Chomp's.

import { useEffect, useState } from "react";
import { ExternalLink, Maximize2, X } from "lucide-react";
import { allowedEmbedUrl } from "../../lib/embed";

const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

export default function Embed({ url, title, height }: { url: string; title?: string; height?: number }) {
  const [expanded, setExpanded] = useState(false);
  const src = allowedEmbedUrl(url, window.location.origin);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (!src) return <div className="text-[13px] text-text-muted">Embed blocked: origin not allowlisted.</div>;

  const iconBtn = "p-1.5 rounded-sm border-none bg-transparent text-text-muted hover:text-text-primary cursor-pointer flex items-center transition-colors";

  return (
    <div className={expanded ? "fixed inset-0 z-50 flex flex-col bg-base" : "rounded-lg border border-border overflow-hidden bg-glass"}>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-[13px] text-text-secondary truncate">{title || "Embed"}</span>
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
        src={src}
        title={title || "Embed"}
        sandbox={EMBED_SANDBOX}
        allow="clipboard-read; clipboard-write"
        className={`w-full border-0 bg-black ${expanded ? "flex-1" : ""}`}
        style={expanded ? undefined : { height: height ?? 480 }}
      />
    </div>
  );
}
