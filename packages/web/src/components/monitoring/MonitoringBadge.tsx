import { useMonitoringCounts } from "../../hooks/useMonitoring";

/** Tracked services with a problem, next to Monitoring in the sidebar: red when one is down. Nothing when all is well. */
export default function MonitoringBadge() {
  const counts = useMonitoringCounts();
  const issues = counts ? counts.down + counts.stale : 0;
  if (!counts || !issues) return null;
  return (
    <span
      className={`ml-auto rounded-full px-1.5 font-mono text-[11px] leading-[18px] tabular-nums ${
        counts.down ? "bg-error/15 text-error" : "bg-accent-ink/15 text-accent-ink"
      }`}
      title={`${counts.down} down, ${counts.stale} not checked lately, of ${counts.total} tracked`}
    >
      {issues}/{counts.total}
    </span>
  );
}
