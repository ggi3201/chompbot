import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Power, Terminal as TerminalIcon } from "lucide-react";
import type { TerminalInfo } from "@chomp/shared";
import { IconButton } from "../ui";
import PaneFrame from "../PaneFrame";
import TerminalView from "./TerminalView";
import EndShellButton from "./EndShellButton";
import { createTerminal, endTerminal, openLatestTerminal, useTerminalFontSize } from "../../hooks/useTerminals";
import { useTerminalSession } from "../../hooks/useTerminalSession";
import { folderLabel, terminalLabel } from "../../lib/terminal/labels";

function ChatShell({ terminal, isMobile, onNewShell, onClose }: { terminal: TerminalInfo; isMobile: boolean; onNewShell: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const { fontSize } = useTerminalFontSize();
  const session = useTerminalSession(terminal.id, fontSize);
  return (
    <PaneFrame
      label="Terminal"
      isMobile={isMobile}
      initialMode={isMobile ? "full" : "docked"}
      dockWidthKey="chomp.terminal.dockWidth"
      onClose={onClose}
      title={
        <>
          <TerminalIcon size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
          <span className="min-w-0 truncate text-[13px] text-text-secondary" title={terminal.cwd}>
            {terminalLabel(terminal, session.title)}
          </span>
          {session.title && <span className="hidden md:inline shrink-0 font-mono text-xs text-text-muted">{folderLabel(terminal.cwd)}</span>}
        </>
      }
      actions={
        <>
          {session.size && !isMobile && <span className="px-1.5 font-mono text-xs text-text-muted">{session.size.cols}×{session.size.rows}</span>}
          <IconButton label="Open on the Terminal page" onClick={() => navigate(`/terminal/${terminal.id}`)}>
            <ExternalLink size={14} strokeWidth={1.5} />
          </IconButton>
          <EndShellButton onEnd={() => void endTerminal(terminal.id)}>
            <Power size={14} strokeWidth={1.5} />
          </EndShellButton>
        </>
      }
    >
      <TerminalView session={session} onNewShell={onNewShell} />
    </PaneFrame>
  );
}

/** The chat's shell, in the folder its agents work in. Opening the pane opens its latest shell, or a first one. */
export default function TerminalPane({ conversationId, isMobile, onClose }: { conversationId: string; isMobile: boolean; onClose: () => void }) {
  const [opened, setOpened] = useState<{ conversationId: string; terminal: TerminalInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminal = opened?.conversationId === conversationId ? opened.terminal : null;

  useEffect(() => {
    let cancelled = false;
    openLatestTerminal({ scope: "chat", conversationId })
      .then((t) => !cancelled && setOpened({ conversationId, terminal: t }))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const newShell = () => {
    setError(null);
    createTerminal({ scope: "chat", conversationId })
      .then((t) => setOpened({ conversationId, terminal: t }))
      .catch((e: Error) => setError(e.message));
  };

  if (terminal) return <ChatShell key={terminal.id} terminal={terminal} isMobile={isMobile} onNewShell={newShell} onClose={onClose} />;
  return (
    <PaneFrame label="Terminal" isMobile={isMobile} initialMode={isMobile ? "full" : "docked"} dockWidthKey="chomp.terminal.dockWidth" onClose={onClose} title={<span className="text-[13px] text-text-secondary">Terminal</span>}>
      <div className="flex-1 min-h-0 flex items-center justify-center p-6 bg-surface-alt text-center">
        <p className={`m-0 max-w-sm text-[13px] whitespace-pre-wrap ${error ? "text-error" : "text-text-secondary"}`}>{error ?? "Starting a shell"}</p>
      </div>
    </PaneFrame>
  );
}
