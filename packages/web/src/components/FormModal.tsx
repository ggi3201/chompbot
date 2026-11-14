import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./ui";

interface FormModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
  wide?: boolean;
}

export default function FormModal({ title, open, onClose, onSubmit, children, wide }: FormModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className={`border border-white/12 ${wide ? "md:max-w-[620px]" : "md:max-w-[500px]"} w-full md:w-[90vw] h-[100dvh] md:h-auto md:max-h-[85dvh] rounded-none md:rounded-xl m-0 md:m-auto p-0 fixed inset-0 bg-glass text-text-primary shadow-modal flex flex-col`}
    >
      {/* Sticky header */}
      <div className="flex items-center justify-between px-4 md:px-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 border-b border-white/10 shrink-0">
        <h3 className="m-0 text-text-primary text-[17px] font-medium">{title}</h3>
        <button type="button" onClick={onClose} className="p-1.5 -mr-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-white/10 transition-colors">
          <X size={18} />
        </button>
      </div>

      {/* Scrollable content */}
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex flex-col flex-1 min-h-0"
      >
        <div className="flex flex-col gap-3 px-4 md:px-6 py-4 overflow-y-auto flex-1">
          {children}
        </div>

        {/* Sticky footer */}
        <div className="flex gap-2 justify-end px-4 md:px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 border-t border-white/10 shrink-0">
          <Button type="button" variant="outline" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md">
            Save
          </Button>
        </div>
      </form>
    </dialog>
  );
}
