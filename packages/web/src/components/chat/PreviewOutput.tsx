import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import type { PreviewClientMessage, PreviewLogLine, PreviewLogSource, PreviewState } from "@chomp/shared";
import { sameSource } from "../../hooks/usePreviewStream";
import { IconButton, LiveDot } from "../ui";

const STATUS_LABELS = { starting: "starting", running: "running", exited: "stopped" } as const;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CONSOLE = "console";

interface Entry {
  key: string;
  label: string;
  meta: string;
  running: boolean;
  startable: boolean;
}

const sourceOf = (key: string): PreviewLogSource => (key === CONSOLE ? { kind: "console" } : { kind: "server", name: key.slice("server:".length) });

/** The open page's port, when the page is on this host and no server Chomp started serves it. */
function outsidePort(state: PreviewState): string | null {
  if (!state.page) return null;
  try {
    const url = new URL(state.page.url);
    const port = url.port || "80";
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
    return state.servers.some((s) => s.status !== "exited" && String(s.port) === port) ? null : port;
  } catch {
    return null;
  }
}

/** The page's console and the output of the dev servers Chomp started, one at a time. */
export default function PreviewOutput({ state, logs, connected, send }: {
  state: PreviewState;
  logs: { source: PreviewLogSource; lines: PreviewLogLine[] } | null;
  connected: boolean;
  send: (message: PreviewClientMessage) => void;
}) {
  const names = [...new Set([...state.configs.map((c) => c.name), ...state.servers.map((s) => s.name)])];
  const entries: Entry[] = [
    ...(state.page ? [{ key: CONSOLE, label: "Console", meta: "", running: false, startable: false }] : []),
    ...names.map((name) => {
      const server = state.servers.find((s) => s.name === name);
      const port = server?.port ?? state.configs.find((c) => c.name === name)?.port;
      return {
        key: `server:${name}`,
        label: name,
        meta: `:${port} ${server ? STATUS_LABELS[server.status] : ""}`,
        running: !!server && server.status !== "exited",
        startable: state.configs.some((c) => c.name === name),
      };
    }),
  ];
  const [picked, setPicked] = useState<string | null>(null);
  const current = entries.find((e) => e.key === picked) ?? entries.find((e) => e.running) ?? entries[0] ?? null;
  const followKey = current?.key ?? null;
  const lines = logs && followKey && sameSource(logs.source, sourceOf(followKey)) ? logs.lines : [];
  const outside = outsidePort(state);
  const output = useRef<HTMLPreElement>(null);

  // Following is a subscription on the host, so it is renewed on every reconnect.
  useEffect(() => {
    if (!connected || !followKey) return;
    send({ type: "logs", source: sourceOf(followKey) });
    return () => send({ type: "logs", source: null });
  }, [followKey, connected, send]);

  // Stays at the newest line, as a terminal does.
  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [lines.length, followKey]);

  return (
    <section aria-label="Output" className="shrink-0 h-[40%] min-h-32 flex flex-col border-t border-border bg-surface">
      {state.configError && <p className="m-0 px-3 py-2 text-[13px] text-error">{state.configError}</p>}
      <ul className="m-0 p-1 list-none flex flex-wrap gap-1 border-b border-border">
        {entries.map((entry) => (
          <li key={entry.key} className={`flex items-center gap-1 pl-2 rounded-md ${entry.key === followKey ? "bg-raised" : ""}`}>
            <button type="button" onClick={() => setPicked(entry.key)} className="flex items-center gap-2 h-8 pr-2 bg-transparent border-none cursor-pointer text-[13px] text-text-primary">
              {entry.key !== CONSOLE && <LiveDot live={entry.running} />}
              {entry.label}
              {entry.meta && <span className="font-mono text-xs text-text-muted">{entry.meta}</span>}
            </button>
            {entry.running && (
              <IconButton tooltip="start" label={`Stop ${entry.label}`} tone="danger" onClick={() => send({ type: "stop", name: entry.label })}><Square size={14} strokeWidth={1.5} /></IconButton>
            )}
            {!entry.running && entry.startable && (
              <IconButton tooltip="start" label={`Start ${entry.label}`} disabled={!connected} onClick={() => send({ type: "start", name: entry.label })}><Play size={14} strokeWidth={1.5} /></IconButton>
            )}
          </li>
        ))}
      </ul>
      {outside && (
        <p className="m-0 px-3 py-2 border-b border-border text-[13px] text-text-muted">
          The server on :{outside} was started outside Chomp, so its output is not here. Started from .claude/launch.json, it would be.
        </p>
      )}
      <pre ref={output} className="flex-1 min-h-0 m-0 px-3 py-2 overflow-auto font-mono text-xs leading-5 text-text-secondary whitespace-pre-wrap break-words">
        {lines.map((l, i) => (
          <div key={`${l.at}-${i}`} className={followKey === CONSOLE && l.stream === "err" ? "text-error" : undefined}>{l.text || " "}</div>
        ))}
        {followKey && lines.length === 0 && <span className="text-text-muted">No output yet.</span>}
        {!followKey && <span className="text-text-muted">Nothing to show. Open a page, or add a server to .claude/launch.json.</span>}
      </pre>
    </section>
  );
}
