import type { HostTile as Tile, HostTiles } from "../../hooks/useMonitoring";
import { formatClock, formatElapsed } from "../../lib/format";
import { SparkCurve } from "../dashboard/CurveChart";
import { Button, GlassCard } from "../ui";
import StatusDot from "./StatusDot";

// The Dashboard's colors: the lead series amber, the others its secondary colors.
const ROWS = [
  { key: "cpu", label: "CPU", color: "#f2a33a" },
  { key: "mem", label: "Memory", color: "#5c5c62" },
  { key: "disk", label: "Disk", color: "#3f88d4" },
] as const;

/** A quiet CPU would be a flat line at the bottom of 0-100, so its scale is at least this. */
const CPU_MIN_TOP = 25;

const percent = (value: number | null) => (value === null ? "–" : `${Math.round(value)}%`);

function meta({ state, lastSeen, uptimeSec, metrics }: Tile): string {
  if (lastSeen === null) return "no data";
  if (state !== "up") return `last seen ${formatClock(lastSeen)}`;
  const parts = [
    uptimeSec !== null && `up ${formatElapsed(uptimeSec)}`,
    metrics.temp !== undefined && `${Math.round(metrics.temp)}°C`,
    metrics.battery !== undefined && `${Math.round(metrics.battery)}% battery`,
  ];
  return parts.filter(Boolean).join(" · ");
}

function Body({ tile, limits }: { tile: Tile; limits: HostTiles["limits"] }) {
  const { metrics, spark } = tile;
  // Home Assistant without the System Monitor integration: reachable, but it measures nothing.
  if (tile.state === "up" && ROWS.every(({ key }) => metrics[key] === null)) {
    return <p className="m-0 text-[13px] text-text-muted">Reachable. It reports no cpu, memory or disk.</p>;
  }
  return (
    <>
      {ROWS.map(({ key, label, color }) => {
        const value = metrics[key];
        const over = key !== "cpu" && value !== null && value > limits[key];
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-text-secondary">{label}</span>
              <span className={`text-xl leading-none font-medium tabular-nums ${over ? "text-accent-ink" : "text-text-primary"}`}>{percent(value)}</span>
            </div>
            <SparkCurve values={spark[key]} color={color} max={key === "cpu" ? Math.max(CPU_MIN_TOP, ...spark.cpu) : 100} />
          </div>
        );
      })}
    </>
  );
}

interface HostTileProps {
  tile: Tile;
  limits: HostTiles["limits"];
  onSetUp: (host: string) => void;
  busy: boolean;
}

/** One host: its state, uptime, and cpu, memory and disk with a day of trend. A host that went quiet greys out. */
export default function HostTile({ tile, limits, onSetUp, busy }: HostTileProps) {
  return (
    <GlassCard className={`flex min-w-0 flex-col gap-3 p-5 ${tile.state === "up" ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {tile.state === "unknown" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted" /> : <StatusDot state={tile.state} />}
        <span className="text-[13px] whitespace-nowrap text-text-secondary">{tile.title}</span>
        <span className="ml-auto font-mono text-xs text-text-muted">{meta(tile)}</span>
      </div>
      {tile.lastSeen !== null && <Body tile={tile} limits={limits} />}
      {tile.lastSeen === null && tile.agent !== null && (
        <>
          <p className="m-0 text-[13px] text-text-muted">No agent has reported yet.</p>
          <Button variant="outline" size="sm" className="self-start" onClick={() => onSetUp(tile.host)} disabled={busy}>Set up agent</Button>
        </>
      )}
    </GlassCard>
  );
}
