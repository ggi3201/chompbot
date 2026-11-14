import { useState } from "react";
import { Button, LiveDot } from "../ui";
import { isTouch } from "../../hooks/useIsMobile";
import type { TerminalSession } from "../../hooks/useTerminalSession";
import KeyBar from "./KeyBar";
import TextSheet from "./TextSheet";

const WAITING = { connecting: "Connecting", reconnecting: "Reconnecting" } as const;

function exitText(exit: { code: number | null; signal: number | null } | null): string {
  if (exit?.signal) return `signal ${exit.signal}`;
  if (exit?.code !== null && exit?.code !== undefined) return `code ${exit.code}`;
  return "";
}

/** The terminal's screen with what can happen to it laid over: waiting, ended, gone, or sized by another screen. */
export default function TerminalView({ session, onNewShell }: { session: TerminalSession; onNewShell: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const { status } = session;
  const ended = status === "ended" || !!session.exit;
  const waiting = status === "connecting" || status === "reconnecting" ? WAITING[status] : null;
  const lost = status === "gone" || status === "refused";

  const paste = async () => {
    session.paste(await navigator.clipboard.readText());
    session.focus();
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col bg-surface-alt">
      <div ref={session.container} className={`flex-1 min-h-0 overflow-hidden pl-3 pr-1 pt-2 pb-1 md:pl-4 md:pt-3 ${ended || lost ? "opacity-60" : ""} transition-opacity`} />

      {waiting && (
        <div role="status" className="absolute top-2 right-3 flex items-center gap-1.5 h-6 px-2 rounded-md bg-raised font-mono text-[11px] text-text-secondary pointer-events-none">
          <LiveDot />
          {waiting}
        </div>
      )}

      {session.sizedElsewhere && !ended && !lost && session.size && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 h-8 pl-3 pr-1 rounded-md bg-raised border border-border text-[12px] text-text-secondary whitespace-nowrap">
          <span>
            Sized for another screen <span className="font-mono text-text-muted">{session.size.cols}×{session.size.rows}</span>
          </span>
          <button type="button" onClick={session.fitHere} className="h-6 px-2 rounded-sm border-none bg-surface text-text-primary text-[12px] cursor-pointer hover:bg-[#2a2a2d] transition-colors">
            Fit here
          </button>
        </div>
      )}

      {ended && (
        <div className="flex items-center gap-3 px-4 h-12 shrink-0 border-t border-border bg-surface">
          <span className="flex-1 min-w-0 text-[13px] text-text-secondary truncate">
            Shell exited <span className="font-mono text-text-muted">{exitText(session.exit)}</span>
          </span>
          <Button size="sm" variant="primary" onClick={onNewShell}>
            New shell
          </Button>
        </div>
      )}

      {lost && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="m-0 max-w-xs text-[13px] text-text-secondary">
            {status === "gone" ? "This shell is gone. It ended, or the host restarted." : "Terminals open only over the tailnet or the LAN."}
          </p>
          {status === "gone" && (
            <Button size="sm" variant="primary" onClick={onNewShell}>
              New shell
            </Button>
          )}
        </div>
      )}

      {session.error && !lost && <p role="alert" className="m-0 px-4 py-2 border-t border-border text-[12px] text-error">{session.error}</p>}

      {isTouch && !ended && !lost && (
        <KeyBar
          modifiers={session.modifiers}
          onKey={(key) => {
            session.pressKey(key);
            // Within the tap, so iOS keeps the keyboard up even if the tap took focus.
            session.focus();
          }}
          onPaste={() => void paste()}
          onSelect={() => setText(session.readText())}
        />
      )}

      {text !== null && (
        <TextSheet
          text={text}
          onClose={() => {
            setText(null);
            session.focus();
          }}
        />
      )}
    </div>
  );
}
