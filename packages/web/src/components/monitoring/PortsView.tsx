import { useState } from "react";
import { useMonitoringResource, type PortRow } from "../../hooks/useMonitoring";
import { FilterPill, GlassCard } from "../ui";
import ExposureBadge from "./ExposureBadge";

const GRID = "grid grid-cols-[4rem_minmax(0,1fr)_7.5rem] gap-x-4 md:grid-cols-[4.5rem_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_7.5rem_minmax(0,1.5fr)]";

function Row({ row, onOpen }: { row: PortRow; onOpen: (key: string) => void }) {
  return (
    <div className={`${GRID} items-baseline border-b border-border px-4 py-2.5 text-sm last:border-b-0`}>
      <span className="font-mono text-text-primary">{row.port}</span>
      <span className="hidden truncate font-mono text-xs text-text-secondary md:block">{row.bind}</span>
      <span className="truncate text-text-secondary">
        {row.owner}
        {row.host !== "mini" && <span className="ml-2 font-mono text-xs text-text-muted">{row.host}</span>}
        {row.image && <span className="ml-2 font-mono text-xs text-text-muted md:hidden">{row.image}</span>}
      </span>
      <span className="hidden truncate font-mono text-xs text-text-muted md:block">{row.image}</span>
      <span><ExposureBadge exposure={row.exposure} /></span>
      <span className="col-span-3 mt-1 truncate md:col-span-1 md:mt-0">
        {row.targetKey
          ? <button type="button" onClick={() => onOpen(row.targetKey!)} className="cursor-pointer truncate text-left text-text-primary hover:underline">{row.targetTitle}</button>
          : <span className="text-text-muted">Nobody claims it</span>}
      </span>
    </div>
  );
}

/** Every port something listens on, with who owns it and which service it belongs to. */
export default function PortsView({ onOpen }: { onOpen: (key: string) => void }) {
  const { data, error } = useMonitoringResource<{ discoveredAt: string | null; ports: PortRow[] }>("/monitoring/ports");
  const [unclaimedOnly, setUnclaimedOnly] = useState(false);

  if (error) return <p className="text-sm text-error">{error}</p>;
  if (!data) return <p className="text-sm text-text-muted">Loading…</p>;
  if (!data.ports.length) return <p className="text-sm text-text-muted">{data.discoveredAt ? "No listening ports found. This machine may not allow ss." : "Discovery has not run yet."}</p>;

  const unclaimed = data.ports.filter((p) => p.targetKey === null);
  const shown = unclaimedOnly ? unclaimed : data.ports;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <FilterPill active={unclaimedOnly} onClick={() => setUnclaimedOnly(!unclaimedOnly)}>Nobody claims it ({unclaimed.length})</FilterPill>
        <span className="font-mono text-xs text-text-muted">{data.ports.length} ports</span>
      </div>
      <GlassCard className="overflow-hidden">
        <div className={`${GRID} border-b border-border px-4 py-2 font-mono text-xs text-text-muted`}>
          <span>Port</span><span className="hidden md:block">Bind</span><span>Owner</span><span className="hidden md:block">Image</span><span>Reach</span><span className="hidden md:block">Service</span>
        </div>
        {shown.map((row) => <Row key={`${row.host}-${row.port}-${row.bind}`} row={row} onOpen={onOpen} />)}
      </GlassCard>
    </div>
  );
}
