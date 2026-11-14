import type { TargetState } from "../../hooks/useMonitoring";

const colors = {
  up: "bg-success",
  down: "bg-error",
  stale: "bg-accent",
  unknown: "bg-accent",
} as const satisfies Record<TargetState, string>;

export default function StatusDot({ state }: { state: TargetState }) {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors[state]}`} />;
}
