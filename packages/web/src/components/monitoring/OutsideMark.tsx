import type { OutsideStatus } from "../../hooks/useMonitoring";
import { formatTimeAgo } from "../../lib/format";

const DOT = { up: "bg-success", down: "bg-error", stale: "bg-text-muted", unknown: "bg-text-muted" } as const satisfies Record<OutsideStatus["state"], string>;
export const OUTSIDE_TEXT = { up: "text-success", down: "text-error", stale: "text-text-muted", unknown: "text-text-muted" } as const satisfies Record<OutsideStatus["state"], string>;

/** One sentence on how the outside probe sees a public service. */
export function outsideSummary(o: OutsideStatus): string {
  switch (o.state) {
    case "up": return `Reachable from the internet${o.latencyMs === null ? "" : `, ${o.latencyMs} ms`}, checked ${formatTimeAgo(o.lastCheckAt!)}`;
    case "down": return `Down from the internet${o.error ? `: ${o.error}` : ""}`;
    case "stale": return `Not checked from outside since ${formatTimeAgo(o.lastCheckAt!)}`;
    case "unknown": return "Not checked from outside yet";
  }
}

/** A small dot and label: up, down or not checked from outside. The tooltip says more. */
export default function OutsideMark({ outside }: { outside: OutsideStatus }) {
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-text-muted" title={outsideSummary(outside)}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[outside.state]}`} />
      {outside.state === "down" ? "outside down" : "outside"}
    </span>
  );
}
