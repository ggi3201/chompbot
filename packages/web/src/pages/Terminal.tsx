import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { AArrowDown, AArrowUp, MessageCircle, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import type { TerminalInfo } from "@chomp/shared";
import { Button, IconButton } from "../components/ui";
import TerminalView from "../components/terminal/TerminalView";
import EndShellButton from "../components/terminal/EndShellButton";
import { createTerminal, endTerminal, openLatestTerminal, useTerminalFontSize, useTerminals } from "../hooks/useTerminals";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { terminalLabel } from "../lib/terminal/labels";

type FontSize = ReturnType<typeof useTerminalFontSize>;

function Tab({ terminal, active, liveTitle, onEnd }: { terminal: TerminalInfo; active: boolean; liveTitle?: string; onEnd: () => void }) {
  const Icon = terminal.scope === "home" ? TerminalIcon : MessageCircle;
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`group flex items-center h-8 shrink-0 max-w-[220px] rounded-md transition-colors ${active ? "bg-raised text-text-primary" : "text-text-secondary hover:bg-white/4 hover:text-text-primary"}`}
    >
      <Link to={`/terminal/${terminal.id}`} replace className="flex items-center gap-2 h-full min-w-0 pl-2.5 pr-1 no-underline text-inherit" title={terminal.cwd}>
        <Icon size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
        <span className="truncate text-[13px]">{terminalLabel(terminal, active ? liveTitle : undefined)}</span>
      </Link>
      <span className={active ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity max-md:opacity-100"}>
        <EndShellButton small onEnd={onEnd}>
          <X size={12} strokeWidth={1.5} />
        </EndShellButton>
      </span>
    </div>
  );
}

function Header({ tabs, activeId, liveTitle, size, font, onNew, onEnd }: {
  tabs: TerminalInfo[];
  activeId: string | null;
  liveTitle?: string;
  size?: { cols: number; rows: number } | null;
  font: FontSize;
  onNew: () => void;
  onEnd: (id: string) => void;
}) {
  return (
    <header className="flex items-center gap-2 h-12 md:h-14 px-2 md:px-4 shrink-0 border-b border-border bg-surface">
      <div role="tablist" aria-label="Shells" className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => (
          <Tab key={t.id} terminal={t} active={t.id === activeId} liveTitle={liveTitle} onEnd={() => onEnd(t.id)} />
        ))}
        <IconButton label="New shell" onClick={onNew}>
          <Plus size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {size && <span className="hidden md:inline px-2 font-mono text-xs text-text-muted">{size.cols}×{size.rows}</span>}
        <IconButton label="Smaller text" disabled={!font.canShrink} onClick={font.smaller}>
          <AArrowDown size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="Larger text" disabled={!font.canGrow} onClick={font.larger}>
          <AArrowUp size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
    </header>
  );
}

function ActiveShell({ id, tabs, font, onNew, onEnd }: { id: string; tabs: TerminalInfo[]; font: FontSize; onNew: () => void; onEnd: (id: string) => void }) {
  const session = useTerminalSession(id, font.fontSize);
  return (
    <>
      <Header tabs={tabs} activeId={id} liveTitle={session.title} size={session.size} font={font} onNew={onNew} onEnd={onEnd} />
      <TerminalView session={session} onNewShell={onNew} />
    </>
  );
}

function NoShell({ starting, error, onNew }: { starting: boolean; error: string | null; onNew: () => void }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-6 text-center bg-surface-alt">
      <p aria-hidden className="m-0 font-mono text-lg text-text-muted">
        ~ <span className="inline-block w-[0.6em] h-[1.1em] align-[-0.2em] bg-accent" />
      </p>
      <p className="m-0 max-w-xs text-[13px] text-text-secondary">
        {starting ? "Starting a shell" : "No shell open. Shells keep running on the host when you close the page."}
      </p>
      {!starting && (
        <Button variant="primary" size="sm" onClick={onNew}>
          New shell
        </Button>
      )}
      {error && <p className="m-0 max-w-sm text-[13px] text-error whitespace-pre-wrap">{error}</p>}
    </div>
  );
}

/** Shells on the host, one tab each. New ones open in the home folder; a chat's shells show here too. */
export default function TerminalPage() {
  const { terminalId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { terminals, refresh } = useTerminals();
  const font = useTerminalFontSize();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After the user ends the last shell the page stays empty, instead of starting a new one at once.
  const endedLast = (location.state as { endedLast?: boolean } | null)?.endedLast ?? false;

  const show = (id: string) => navigate(`/terminal/${id}`, { replace: true });

  // Coming here from the menu opens the latest home shell, or a first one.
  useEffect(() => {
    if (terminalId || endedLast) return;
    let cancelled = false;
    openLatestTerminal({ scope: "home" })
      .then(async (t) => {
        await refresh();
        if (!cancelled) navigate(`/terminal/${t.id}`, { replace: true });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [terminalId, endedLast, navigate, refresh]);

  const newShell = async () => {
    setError(null);
    setStarting(true);
    try {
      const t = await createTerminal({ scope: "home" });
      await refresh();
      show(t.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const end = async (id: string) => {
    await endTerminal(id);
    const rest = (await refresh()).filter((t) => t.id !== id);
    if (id !== terminalId) return;
    const next = rest.at(-1);
    if (next) show(next.id);
    else navigate("/terminal", { replace: true, state: { endedLast: true } });
  };

  const tabs = terminals ?? [];
  const opening = !terminalId && !endedLast && !error;

  return (
    <div className="h-full flex flex-col bg-surface">
      {terminalId ? (
        <ActiveShell key={terminalId} id={terminalId} tabs={tabs} font={font} onNew={() => void newShell()} onEnd={(id) => void end(id)} />
      ) : (
        <>
          <Header tabs={tabs} activeId={null} font={font} onNew={() => void newShell()} onEnd={(id) => void end(id)} />
          <NoShell starting={starting || opening} error={error} onNew={() => void newShell()} />
        </>
      )}
    </div>
  );
}
