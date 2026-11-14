import type { DayCount, MonitorTarget } from "../../hooks/useMonitoring";

function dayLabel({ day, up, down }: DayCount): string {
  const date = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  if (up + down === 0) return `${date}: no checks`;
  return down ? `${date}: ${down} of ${up + down} checks failed` : `${date}: all ${up} checks passed`;
}

/** Thirty day bars: red if any check failed that day, green if all passed, grey with no checks. */
export default function History({ target }: { target: Pick<MonitorTarget, "days" | "uptime"> }) {
  const label = target.uptime === null ? "No history" : `${target.uptime}% up over 30 days`;
  return (
    <div role="img" aria-label={label} className="flex h-5 flex-1 gap-px sm:w-36 sm:flex-none">
      {target.days.map((d) => (
        <span
          key={d.day}
          title={dayLabel(d)}
          className={`flex-1 rounded-[1px] ${d.down ? "bg-error" : d.up ? "bg-success/60" : "bg-raised"}`}
        />
      ))}
    </div>
  );
}
