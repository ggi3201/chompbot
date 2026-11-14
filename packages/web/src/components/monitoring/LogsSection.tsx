import { RefreshCw } from "lucide-react";
import { useLogs } from "../../hooks/useTargetActions";
import { IconButton } from "../ui";

/** The last 100 lines of the container or unit behind a target. Newest at the bottom, where the box opens scrolled to. */
export default function LogsSection({ targetKey }: { targetKey: string }) {
  const { logs, error, loading, refresh } = useLogs(targetKey);

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="m-0 text-[13px] font-medium text-text-secondary">Logs</h4>
        {logs && <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{logs.name}</span>}
        <IconButton label="Refresh logs" disabled={loading} onClick={() => void refresh()} className="ml-auto">
          <RefreshCw size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
      {error && <p className="m-0 text-sm text-error">{error}</p>}
      {logs && (
        // column-reverse starts the scroll at the end, so the newest line is in view without script.
        <div className="flex max-h-64 flex-col-reverse overflow-auto rounded-md border border-border bg-surface">
          <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
            {logs.lines.length ? logs.lines.join("\n") : "No log lines."}
          </pre>
        </div>
      )}
    </section>
  );
}
