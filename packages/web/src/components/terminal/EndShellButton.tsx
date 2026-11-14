import { useState, type ReactNode } from "react";
import { IconButton } from "../ui";

const DISARM_MS = 3_000;

/** Ends a shell in two presses: the first arms it for a moment, so a stray click cannot kill a running vim. */
export default function EndShellButton({ onEnd, children, small = false }: { onEnd: () => void; children: ReactNode; small?: boolean }) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    return (
      <button
        type="button"
        autoFocus
        onClick={(e) => {
          e.stopPropagation();
          onEnd();
        }}
        onBlur={() => setArmed(false)}
        className={`shrink-0 px-2 rounded-md border-none bg-error/15 text-error text-[12px] font-medium cursor-pointer ${small ? "h-6" : "h-8"}`}
      >
        End shell
      </button>
    );
  }
  return (
    <IconButton
      label="End shell"
      tone="danger"
      className={small ? "w-6! h-6!" : ""}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setArmed(true);
        setTimeout(() => setArmed(false), DISARM_MS);
      }}
    >
      {children}
    </IconButton>
  );
}
