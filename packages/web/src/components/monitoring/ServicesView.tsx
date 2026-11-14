import { useState } from "react";
import { EXPOSURE_LEVELS, type MonitorTarget } from "../../hooks/useMonitoring";
import { ChoicePills, GlassCard } from "../ui";
import ServiceRow, { SERVICE_GRID } from "./ServiceRow";

const OTHER = "Other";
const SCOPES = [{ id: "all" }, { id: "tracked" }];
const EXPOSURE_FILTERS = [{ id: "any" }, ...EXPOSURE_LEVELS.map((id) => ({ id }))];

/** Projects with something wrong come first, then A to Z; "Other" is last. */
function groupByProject(targets: MonitorTarget[]): [string, MonitorTarget[]][] {
  const groups = targets.reduce((map, t) => map.set(t.project ?? OTHER, [...(map.get(t.project ?? OTHER) ?? []), t]), new Map<string, MonitorTarget[]>());
  const needsLook = (list: MonitorTarget[]) => list.some((t) => t.state === "down");
  return [...groups].sort(([nameA, a], [nameB, b]) =>
    Number(nameA === OTHER) - Number(nameB === OTHER) || Number(needsLook(b)) - Number(needsLook(a)) || nameA.localeCompare(nameB));
}

function ColumnHeads() {
  return (
    <div className={`hidden px-4 pb-1 font-mono text-xs text-text-muted ${SERVICE_GRID}`}>
      <span>Service</span><span>Where</span><span>Reach</span><span className="text-right">Ping</span><span>30 days</span><span className="text-right">Up</span>
    </div>
  );
}

function Group({ title, targets, onOpen }: { title: string; targets: MonitorTarget[]; onOpen: (key: string) => void }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-text-secondary">{title}</h3>
      <GlassCard className="overflow-hidden">
        {targets.map((t) => <ServiceRow key={t.key} target={t} onOpen={onOpen} />)}
      </GlassCard>
    </section>
  );
}

/** A group that starts folded: what discovery found but nobody asked to watch, and what was hidden. */
function Folded({ title, targets, onOpen }: { title: string; targets: MonitorTarget[]; onOpen: (key: string) => void }) {
  if (!targets.length) return null;
  return (
    <details>
      <summary className="mb-2 cursor-pointer text-sm font-medium text-text-secondary hover:text-text-primary">{title} ({targets.length})</summary>
      <GlassCard className="overflow-hidden">
        {targets.map((t) => <ServiceRow key={t.key} target={t} onOpen={onOpen} />)}
      </GlassCard>
    </details>
  );
}

export default function ServicesView({ targets, onOpen }: { targets: MonitorTarget[]; onOpen: (key: string) => void }) {
  const [scope, setScope] = useState("all");
  const [exposure, setExposure] = useState("any");

  const matching = targets.filter((t) => exposure === "any" || t.exposure === exposure);
  const shown = matching.filter((t) => !t.hidden && !t.retired);
  const tracked = shown.filter((t) => t.tracked);
  const parked = matching.filter((t) => t.hidden || t.retired);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-6">
        <ChoicePills options={SCOPES} value={scope} onChange={setScope} />
        <ChoicePills options={EXPOSURE_FILTERS} value={exposure} onChange={setExposure} />
      </div>
      <div className="flex flex-col gap-6">
        <ColumnHeads />
        {groupByProject(tracked).map(([project, list]) => <Group key={project} title={project} targets={list} onOpen={onOpen} />)}
        {!tracked.length && <p className="text-sm text-text-muted">No tracked service matches.</p>}
        {scope === "all" && (
          <>
            <Folded title="Found, not tracked" targets={shown.filter((t) => !t.tracked)} onOpen={onOpen} />
            <Folded title="Hidden or retired" targets={parked} onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  );
}
