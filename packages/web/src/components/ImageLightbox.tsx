import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/** A chat image: a thumbnail that opens full size in a modal instead of a new browser tab. */
export default function ImageLightbox({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  if (!src) return null;
  const label = alt ?? "Uploaded image";

  // A dead link should look broken on purpose, not like an empty frame.
  if (failed) {
    return <span className="my-2 inline-block rounded-md border border-dashed border-border px-2 py-1 text-[13px] text-text-secondary">Image missing{alt ? `: ${alt}` : ""}</span>;
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block my-2 cursor-zoom-in" aria-label={`Open ${label}`}>
        <img src={src} alt={label} className="max-h-[360px] max-w-full rounded-md border border-border object-contain" loading="lazy" onError={() => setFailed(true)} />
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          onClose={() => setOpen(false)}
          // Native dialog: Esc closes it. A click on the backdrop lands on the dialog itself, not on the image.
          onClick={(event) => event.target === event.currentTarget && setOpen(false)}
          className="fixed inset-0 m-0 flex h-[100dvh] max-h-none w-full max-w-none items-center justify-center bg-transparent p-4 backdrop:bg-black/80"
        >
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] rounded-lg bg-black/50 p-2 text-white hover:bg-black/70">
            <X size={18} />
          </button>
          <img src={src} alt={label} className="max-h-full max-w-full rounded-md object-contain shadow-modal" />
        </dialog>
      )}
    </>
  );
}
