import { useState } from "react";
import { useHostSeries, type HostTile } from "../../hooks/useMonitoring";
import { CurveChart } from "../dashboard/CurveChart";
import PanelTitle from "../dashboard/PanelTitle";
import { RANGE_OPTIONS, RANGE_TICKS, RANGE_TITLES, tipOf, type Range } from "../dashboard/ranges";
import { ChoicePills, GlassCard } from "../ui";

const Empty = ({ children }: { children: string }) => <div className="text-[13px] text-text-muted">{children}</div>;

/** Cpu, memory and disk of one host over a day, a week or a month, drawn as the Dashboard draws its activity. */
export default function HostChart({ hosts }: { hosts: HostTile[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("24h");
  // The first host that has reported, until someone picks another.
  const host = picked ?? (hosts.find((h) => h.lastSeen !== null) ?? hosts[0]).host;
  const { data, error } = useHostSeries(host, range);

  // The previous answer stays on screen while the next one loads; it is not this host's or this range's.
  const current = data?.host === host && data.range === range ? data : null;
  const dates = current?.times.map((t) => new Date(t)) ?? [];

  return (
    <GlassCard className="flex min-w-0 flex-col p-6">
      <PanelTitle title={`${host}, ${RANGE_TITLES[range].toLowerCase()}`} meta={<ChoicePills options={RANGE_OPTIONS} value={range} onChange={(id) => setRange(id as Range)} />} />
      <div className="-mt-2 mb-4"><ChoicePills options={hosts.map((h) => ({ id: h.host, label: h.title }))} value={host} onChange={setPicked} /></div>
      {error && <p className="m-0 text-sm text-error">{error}</p>}
      {!error && !current && <Empty>Loading…</Empty>}
      {current && !dates.length && <Empty>No readings in this range yet</Empty>}
      {current && dates.length > 0 && (
        <CurveChart
          label={`CPU, memory and disk of ${host}, ${RANGE_TITLES[range].toLowerCase()}`}
          ticks={dates.map(RANGE_TICKS[range])}
          tips={dates.map(tipOf)}
          max={100}
          unit="%"
          series={[
            { key: "cpu", label: "CPU", color: "#f2a33a", data: current.series.cpu, lead: true },
            { key: "mem", label: "Memory", color: "#5c5c62", data: current.series.mem },
            { key: "disk", label: "Disk", color: "#3f88d4", data: current.series.disk },
          ]}
        />
      )}
    </GlassCard>
  );
}
