import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui";

/**
 * The terminal's text as real text, so a phone can select it the native way.
 * xterm draws on a canvas, which iOS cannot select in.
 */
export default function TextSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyAll = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <div role="dialog" aria-label="Terminal text" className="absolute inset-0 z-20 flex flex-col bg-surface-alt">
      <div className="flex items-center gap-2 h-12 px-3 shrink-0 border-b border-border bg-surface">
        <span className="flex-1 min-w-0 text-[13px] text-text-secondary truncate">Select text to copy it</span>
        <Button size="sm" variant="outline" onClick={() => void copyAll()}>
          {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
          {copied ? "Copied" : "Copy all"}
        </Button>
        <Button size="sm" variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
      <pre
        // Opens at the end, where the latest output is.
        ref={(el) => {
          if (el) el.scrollTop = el.scrollHeight;
        }}
        className="flex-1 min-h-0 m-0 overflow-auto px-4 py-3 border-0 rounded-none bg-surface-alt font-mono text-[12px] leading-[1.4] text-text-primary whitespace-pre-wrap break-all select-text"
      >
        {text || " "}
      </pre>
    </div>
  );
}
