import type { MonitorTarget } from "../../hooks/useMonitoring";
import { formatTimeAgo } from "../../lib/format";
import ExposureBadge from "./ExposureBadge";
import History from "./History";
import OutsideMark from "./OutsideMark";
import StatusDot from "./StatusDot";

/** Name, where, exposure, latency, 30 days, uptime. Shared by the column heads so they line up. */
export const SERVICE_GRID = "md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_7.5rem_3.5rem_9rem_3.5rem] md:items-center md:gap-4";

function detail(t: MonitorTarget): string | null {
  const container = t.containerState && t.containerState.state !== "running" ? `Container ${t.containerState.state}` : null;
  switch (t.state) {
    case "down": return t.message || "Down";
    case "stale": return t.lastCheckAt ? `Last check ${formatTimeAgo(t.lastCheckAt)}` : "Never checked";
    case "unknown": return "Retrying";
    case "up": return container ?? (t.kind === "push" ? t.message : null); // for HTTP, "200" is noise and an expected 401 looks like a problem
  }
}

function reading(t: MonitorTarget): string {
  if (t.kind === "push") return t.lastPushAt ? formatTimeAgo(t.lastPushAt) : "";
  if (t.latencyMs === null) return t.lastCheckAt ? formatTimeAgo(t.lastCheckAt) : "";
  return t.latencyMs < 1 ? "<1 ms" : `${t.latencyMs} ms`;
}

/** Where it runs: the container or unit when there is one, else host and port. */
export function whereOf(t: MonitorTarget): string {
  const port = t.port === null ? "" : `:${t.port}`;
  if (t.container) return t.bind ? `${t.container}${port}` : `${t.container}`;
  if (t.unit) return `${t.unit.replace(/\.service$/, "")}${port}`;
  return t.host ? `${t.host}${port}` : "";
}

export default function ServiceRow({ target, onOpen }: { target: MonitorTarget; onOpen: (key: string) => void }) {
  const note = detail(target);
  const restarts = target.containerState?.restarts;
  return (
    <button
      type="button"
      onClick={() => onOpen(target.key)}
      className={`block w-full cursor-pointer border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/4 ${SERVICE_GRID}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusDot state={target.state} />
          <span className="truncate text-sm text-text-primary">{target.title}</span>
          {target.outside && <OutsideMark outside={target.outside} />}
          {target.warnings.length > 0 && <span className="shrink-0 font-mono text-xs text-accent-ink" title={target.warnings.map((w) => w.text).join("\n")}>{target.warnings.length} {target.warnings.length === 1 ? "warning" : "warnings"}</span>}
        </div>
        {note && <div className="mt-0.5 truncate pl-3.5 text-xs text-text-muted">{note}</div>}
      </div>
      <div className="mt-1 min-w-0 truncate pl-3.5 font-mono text-xs text-text-secondary md:mt-0 md:pl-0">
        {whereOf(target)}
        {restarts ? <span className="ml-2 text-text-muted">{restarts} restarts</span> : null}
      </div>
      <div className="mt-2 md:mt-0"><ExposureBadge exposure={target.exposure} /></div>
      <span className="hidden text-right font-mono text-xs text-text-muted md:block">{reading(target)}</span>
      <div className="mt-2 flex items-center gap-3 md:mt-0 md:contents">
        <History target={target} />
        <span className="w-14 text-right font-mono text-xs text-text-secondary md:w-auto">{target.uptime === null ? "" : `${target.uptime}%`}</span>
        <span className="w-14 text-right font-mono text-xs text-text-muted md:hidden">{reading(target)}</span>
      </div>
    </button>
  );
}
