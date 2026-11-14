import type { DiagnosisStatus, MonitorIncident } from "../../hooks/useMonitoring";
import { formatElapsed, formatTimeAgo } from "../../lib/format";
import { GlassCard, LiveDot } from "../ui";

export const DIAGNOSIS_LABELS: Record<DiagnosisStatus, string | null> = {
  none: null,
  running: "Diagnosing",
  done: "Diagnosed",
  failed: "Diagnosis failed",
};

/** The facts under an incident's title: what it blames, how many services, and the diagnosis. */
function meta({ cause, targets, diagnosis, flapping }: MonitorIncident): string[] {
  const services = targets.length > 1 ? `${targets.length} services` : null;
  return [cause, services, flapping ? "flapping" : null, DIAGNOSIS_LABELS[diagnosis]].filter((part): part is string => part !== null);
}

function IncidentRow({ incident, onOpen }: { incident: MonitorIncident; onOpen: (id: string) => void }) {
  const { title, startedAt, endedAt, msg, diagnosis } = incident;
  const seconds = endedAt ? Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000) : 0;
  return (
    <button
      type="button"
      onClick={() => onOpen(incident.id)}
      className="flex w-full cursor-pointer items-baseline gap-4 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-white/4"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-primary">{title}</div>
        {msg && <div className="mt-0.5 truncate text-xs text-text-muted">{msg}</div>}
        <div className="mt-0.5 flex items-center gap-2 truncate font-mono text-xs text-text-muted">
          {diagnosis === "running" && <LiveDot />}
          {meta(incident).join(" · ")}
        </div>
      </div>
      <div className="shrink-0 text-right font-mono text-xs">
        <div className={endedAt ? "text-text-secondary" : "text-error"}>{endedAt ? formatElapsed(seconds) : "Ongoing"}</div>
        <div className="mt-0.5 text-text-muted">{formatTimeAgo(startedAt)}</div>
      </div>
    </button>
  );
}

export default function IncidentList({ incidents, onOpen }: { incidents: MonitorIncident[]; onOpen: (id: string) => void }) {
  if (!incidents.length) return <p className="text-sm text-text-muted">No incidents in the last 30 days.</p>;
  return (
    <GlassCard className="overflow-hidden">
      {incidents.map((i) => <IncidentRow key={i.id} incident={i} onOpen={onOpen} />)}
    </GlassCard>
  );
}
