import { useMonitoringResource, type ExposureLevel, type OverviewWarning } from "../../hooks/useMonitoring";
import { GlassCard } from "../ui";
import PanelTitle from "../dashboard/PanelTitle";
import { OUTSIDE_TEXT } from "./OutsideMark";
import StatusDot from "./StatusDot";

function Warnings({ warnings, onOpen }: { warnings: OverviewWarning[]; onOpen: (key: string) => void }) {
  return (
    <ul className="m-0 list-none border-b border-border p-0">
      {warnings.map((w) => (
        <li key={w.key} className="flex items-baseline gap-3 px-4 py-2.5 text-sm text-accent-ink">
          <span className="min-w-0 flex-1">{w.text}</span>
          {w.targetKey && <button type="button" onClick={() => onOpen(w.targetKey!)} className="shrink-0 cursor-pointer font-mono text-xs text-text-muted hover:text-text-primary">Open</button>}
        </li>
      ))}
    </ul>
  );
}

const OUTSIDE_NOTE = { up: "confirmed from outside", down: "down from outside", stale: "not checked from outside", unknown: "not checked from outside" } as const;

function Level({ level, onOpen }: { level: ExposureLevel; onOpen: (key: string) => void }) {
  return (
    <GlassCard className="overflow-hidden">
      <div className="px-4 pt-4"><PanelTitle title={level.label} meta={`${level.targets.length} ${level.targets.length === 1 ? "service" : "services"}`} /></div>
      {level.warnings.length > 0 && <Warnings warnings={level.warnings} onOpen={onOpen} />}
      {level.targets.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onOpen(t.key)}
          className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-white/4"
        >
          <StatusDot state={t.state} />
          <span className="min-w-0 flex-1 truncate text-text-primary">{t.title}</span>
          <span className="hidden truncate font-mono text-xs text-text-muted sm:block">{t.container ?? ""}{t.bind && t.port !== null ? ` ${t.bind}:${t.port}` : ""}</span>
          {t.outside && <span className={`shrink-0 font-mono text-xs ${OUTSIDE_TEXT[t.outside.state]}`}>{OUTSIDE_NOTE[t.outside.state]}</span>}
          <span className="w-16 shrink-0 text-right font-mono text-xs text-text-muted">{t.tracked ? "tracked" : ""}</span>
        </button>
      ))}
    </GlassCard>
  );
}

/** Services grouped by how far they reach, widest first, each level with its warnings on top. */
export default function ExposureView({ onOpen }: { onOpen: (key: string) => void }) {
  const { data, error } = useMonitoringResource<{ levels: ExposureLevel[]; other: OverviewWarning[] }>("/monitoring/exposure");

  if (error) return <p className="text-sm text-error">{error}</p>;
  if (!data) return <p className="text-sm text-text-muted">Loading…</p>;
  const levels = data.levels.filter((l) => l.targets.length || l.warnings.length);
  return (
    <div className="flex flex-col gap-3">
      {data.other.length > 0 && (
        <GlassCard className="overflow-hidden">
          <div className="px-4 pt-4"><PanelTitle title="Other warnings" /></div>
          <Warnings warnings={data.other} onOpen={onOpen} />
        </GlassCard>
      )}
      {levels.map((level) => <Level key={level.level} level={level} onOpen={onOpen} />)}
      {!levels.length && !data.other.length && <p className="text-sm text-text-muted">Nothing found yet. Discovery runs every 5 minutes.</p>}
    </div>
  );
}
