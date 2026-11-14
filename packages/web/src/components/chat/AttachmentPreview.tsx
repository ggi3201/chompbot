import { FileText, X } from "lucide-react";
import { formatFileSize, type PendingAttachment } from "../../lib/attachments";

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  isUploading: boolean;
  onRemove: (index: number) => void;
}

export default function AttachmentPreview({
  attachments,
  isUploading,
  onRemove,
}: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 pt-1.5 flex-wrap items-center">
      {attachments.map((att, i) => {
        const isImage = att.mimeType.startsWith("image/");
        return (
          <div key={i} className="relative">
            {isImage && att.preview ? (
              <img
                src={att.preview}
                alt={att.name}
                title={att.name}
                className={`w-[60px] h-[60px] object-cover rounded-md border border-white/12 ${isUploading ? "opacity-40" : ""}`}
              />
            ) : (
              <div
                title={att.name}
                className={`flex items-center gap-2 h-[60px] px-3 rounded-md border border-white/12 bg-white/4 text-text-secondary max-w-[220px] ${isUploading ? "opacity-40" : ""}`}
              >
                <FileText size={18} className="shrink-0 text-text-muted" />
                <div className="flex flex-col min-w-0">
                  <span className="text-[0.7rem] font-body truncate">{att.name}</span>
                  <span className="text-[11px] font-body text-text-muted">{formatFileSize(att.size)}</span>
                </div>
              </div>
            )}
            {isUploading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
              </div>
            )}
            {!isUploading && (
              // Inside the composer form: without type="button" a click would send the message.
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${att.name}`}
                className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full border border-border bg-raised text-text-secondary hover:text-text-primary cursor-pointer flex items-center justify-center"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        );
      })}
      {isUploading && (
        <span className="text-[11px] font-body text-text-muted">Uploading…</span>
      )}
    </div>
  );
}
