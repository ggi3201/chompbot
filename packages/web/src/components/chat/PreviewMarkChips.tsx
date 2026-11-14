import { X } from "lucide-react";
import type { PreviewMark } from "../../lib/preview";

/** What the user pointed at in the preview, waiting to go with the next message. Numbered as the message numbers them. */
export default function PreviewMarkChips({ marks, onRemove }: { marks: PreviewMark[]; onRemove: (id: number) => void }) {
  if (marks.length === 0) return null;
  return (
    <ul aria-label="Pointed at in the preview" className="m-0 p-0 pt-1.5 list-none flex flex-wrap gap-2">
      {marks.map((mark, i) => (
        <li key={mark.id} className="flex items-center gap-2 max-w-[320px] h-[60px] pl-1 pr-1 rounded-md border border-white/12 bg-white/4">
          {mark.element.crop && (
            <img src={`data:image/jpeg;base64,${mark.element.crop}`} alt="" className="w-[52px] h-[52px] object-cover rounded-sm border border-white/12 shrink-0" />
          )}
          <div className="flex flex-col min-w-0">
            <span className="font-mono text-[11px] text-text-muted truncate">
              {i + 1}. {mark.element.label}
            </span>
            <span className="text-[13px] text-text-secondary truncate">{mark.comment.trim() || "No comment"}</span>
          </div>
          {/* Inside the composer form: without type="button" a click would send the message. */}
          <button
            type="button"
            aria-label={`Remove mark ${i + 1}`}
            onClick={() => onRemove(mark.id)}
            className="shrink-0 self-start mt-1 p-1 rounded-sm bg-transparent border-none text-text-muted cursor-pointer hover:text-text-primary"
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </li>
      ))}
    </ul>
  );
}
