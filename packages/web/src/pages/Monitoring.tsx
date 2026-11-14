import { useSearchParams } from "react-router-dom";
import AttentionList from "../components/monitoring/AttentionList";
import IncidentList from "../components/monitoring/IncidentList";
import IncidentPanel from "../components/monitoring/IncidentPanel";
import PortsView from "../components/monitoring/PortsView";
import ExposureView from "../components/monitoring/ExposureView";
import HostChart from "../components/monitoring/HostChart";
import HostTiles from "../components/monitoring/HostTiles";
import ServicesView from "../components/monitoring/ServicesView";
import SidePanel from "../components/monitoring/SidePanel";
import { RefreshCw } from "lucide-react";
import { Button, ChoicePills, GlassCard, PageHeader } from "../components/ui";
import { diagnoseIncident, useHostTiles, useMonitoring, type DiscoverySource, type MonitoringOverview } from "../hooks/useMonitoring";
import { formatTimeAgo } from "../lib/format";

const VIEWS = ["services", "ports", "exposure", "incidents"] as const;

const SOURCE_NAMES: Record<string, string> = {
  traefik: "Traefik", cloudflare: "Cloudflare tunnel", dns: "Cloudflare DNS", docker: "Docker", listener: "Listening ports",
  tailscale: "Tailscale", "home-ip": "Home IP", "docker-space": "Docker disk", "outside-probe": "Outside probe",
};

function verdict({ counts }: MonitoringOverview): { text: string; color: string } {
  const unsure = counts.stale + counts.unknown;
  if (counts.down) return { text: `${counts.down} of ${counts.total} down`, color: "text-error" };
  if (unsure) return { text: `${unsure} of ${counts.total} need a look`, color: "text-accent-ink" };
  return { text: `All ${counts.total} up`, color: "text-success" };
}

/** The discovery sources that did not answer, so a missing view says why. */
function DiscoveryNotes({ sources }: { sources: DiscoverySource[] }) {
  const missing = sources.filter((s) => s.state !== "ok");
  if (!missing.length) return null;
  return (
    <p className="m-0 flex flex-wrap gap-x-4 font-mono text-xs">
      {missing.map((s) => (
        <span key={s.source} className={s.state === "error" ? "text-error" : "text-text-muted"}>{SOURCE_NAMES[s.source] ?? s.source}: {s.message?.replace(/^./, (c) => c.toLowerCase())}</span>
      ))}
    </p>
  );
}

export default function Monitoring() {
  const { data, error, editTarget, refreshing, refreshNow } = useMonitoring();
  const hosts = useHostTiles();
  const [params, setParams] = useSearchParams();

  const view = VIEWS.find((v) => v === params.get("view")) ?? "services";
  const selected = data?.targets.find((t) => t.key === params.get("target")) ?? null;
  const incidentId = params.get("incident");
  const setParam = (name: "view" | "target" | "incident", value: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    }, { replace: name === "view" });
  const open = (key: string) => setParam("target", key);
  // A target's open incident, so its panel can offer Diagnose.
  const openIncident = selected && data?.incidents.find((i) => i.state === "open" && i.targets.some((t) => t.key === selected.key));
  const diagnoseTargetIncident = async () => {
    if (!openIncident) return;
    await diagnoseIncident(openIncident.id);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("target");
      next.set("incident", openIncident.id);
      return next;
    });
  };

  const summary = data && verdict(data.overview);
  const warningCount = data?.overview.warnings.length ?? 0;

  return (
    <div className="flex max-w-[1600px] flex-col gap-6 p-4 md:p-8">
      <PageHeader
        title="Monitoring"
        action={data && summary && (
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 font-mono text-xs text-text-muted">
            <span className={`text-sm ${summary.color}`}>{summary.text}</span>
            {warningCount > 0 && <span className="text-accent-ink">{warningCount} {warningCount === 1 ? "warning" : "warnings"}</span>}
            <span>checked {formatTimeAgo(data.overview.checkedAt)}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={async () => {
                await refreshNow();
                await hosts.refresh();
              }}
            >
              <RefreshCw size={14} strokeWidth={1.5} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh now"}
            </Button>
          </div>
        )}
      />
      {error && <GlassCard className="p-4 text-sm text-error">{error}</GlassCard>}
      {!data && !error && <p className="text-sm text-text-muted">Loading…</p>}
      {hosts.data && <HostTiles data={hosts.data} issueToken={hosts.issueToken} />}
      {hosts.error && <p className="m-0 text-sm text-error">{hosts.error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
            {hosts.data ? <HostChart hosts={hosts.data.hosts} /> : <GlassCard className="p-6 text-[13px] text-text-muted">Loading…</GlassCard>}
            <AttentionList overview={data.overview} targets={data.targets} onOpen={open} />
          </div>
          <div>
            <ChoicePills options={VIEWS.map((id) => ({ id }))} value={view} onChange={(id) => setParam("view", id === "services" ? null : id)} />
            <div className="mt-3"><DiscoveryNotes sources={data.discovery.sources} /></div>
          </div>
          {view === "services" && <ServicesView targets={data.targets} onOpen={open} />}
          {view === "ports" && <PortsView onOpen={open} />}
          {view === "exposure" && <ExposureView onOpen={open} />}
          {view === "incidents" && <IncidentList incidents={data.incidents} onOpen={(id) => setParam("incident", id)} />}
        </>
      )}
      {selected && <SidePanel key={selected.key} target={selected} onClose={() => setParam("target", null)} onEdit={editTarget} onDiagnose={openIncident ? diagnoseTargetIncident : undefined} />}
      {incidentId && <IncidentPanel key={incidentId} id={incidentId} onClose={() => setParam("incident", null)} onOpenTarget={open} />}
    </div>
  );
}
