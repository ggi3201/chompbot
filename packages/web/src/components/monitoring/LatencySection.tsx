import { useState } from "react";
import { useLatency, type LatencyRange, type LatencySeries } from "../../hooks/useTargetActions";
import { CurveChart } from "../dashboard/CurveChart";
import { ChoicePills } from "../ui";

const HOME = "#f2a33a";
const OUTSIDE = "#3f88d4";
const RANGES = [{ id: "24h" }, { id: "7d" }];

/** The chart takes a number per tick: a gap repeats the last known value, and one at the start takes the first. */
function carryForward(values: (number | null)[]): number[] {
  const first = values.find((v) => v !== null) ?? 0;
  return values.reduce<number[]>((out, v) => [...out, v ?? out.at(-1) ?? first], []);
}

const tickOf = (range: LatencyRange, ts: number) =>
  range === "24h"
    ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : new Date(ts).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });

const tipOf = (ts: number) =>
  new Date(ts).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function seriesOf({ home, outside }: LatencySeries) {
  return [
    { key: "home", label: "Home", color: HOME, data: carryForward(home), lead: true, present: home.length > 0 },
    { key: "outside", label: "Outside", color: OUTSIDE, data: carryForward(outside), present: outside.length > 0 },
  ].filter((s) => s.present);
}

/** Response time of a target as seen from home and, once the outside probe reports, from outside. */
export default function LatencySection({ targetKey }: { targetKey: string }) {
  const [range, setRange] = useState<LatencyRange>("24h");
  const { series, error } = useLatency(targetKey, range);
  const lines = series ? seriesOf(series) : [];

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="m-0 text-[13px] font-medium text-text-secondary">Latency</h4>
        <div className="[&>div]:mt-0">
          <ChoicePills options={RANGES} value={range} onChange={(id) => setRange(id as LatencyRange)} />
        </div>
      </div>
      {error && <p className="m-0 text-sm text-error">{error}</p>}
      {series && lines.length === 0 && <p className="m-0 text-[13px] text-text-muted">No latency data yet.</p>}
      {series && lines.length > 0 && (
        <CurveChart
          label={`Latency over ${range}`}
          ticks={series.ts.map((ts) => tickOf(range, ts))}
          tips={series.ts.map(tipOf)}
          series={lines}
          height={140}
          unit=" ms"
        />
      )}
    </section>
  );
}
