import { useEffect, useState } from "react";
import type { AgentProvider, ProviderUsage, UsageWindow } from "@chomp/shared";
import { apiFetch } from "../../lib/api";

const POLL_MS = 60_000;

/**
 * Plan usage per provider. Refetched every minute and whenever a turn ends,
 * which is when the numbers move; the server caches and probes the CLIs.
 */
export function useUsageLimits(turnActive: boolean): ProviderUsage[] {
  const [usage, setUsage] = useState<ProviderUsage[]>([]);

  useEffect(() => {
    if (turnActive) return;
    let cancelled = false;
    const load = () =>
      apiFetch("/chat/usage-limits")
        .then((res) => (res.ok ? (res.json() as Promise<ProviderUsage[]>) : []))
        .then((data) => {
          if (!cancelled) setUsage(data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [turnActive]);

  return usage;
}

function formatReset(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Resets at ${time}` : `Resets ${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Bar color steps up only when it matters: past 80% it is worth a glance. */
export function barClass(percent: number): string {
  if (percent >= 90) return "bg-error";
  if (percent >= 80) return "bg-accent";
  return "bg-text-secondary";
}

export function UsageBar({ window }: { window: UsageWindow }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-3 text-[13px]">
        <span className="text-text-primary">{window.label}</span>
        <span className="ml-auto font-mono text-xs text-text-muted">{formatReset(window.resetsAt)}</span>
        <span className="w-9 text-right font-mono text-xs text-text-secondary">{window.percent}%</span>
      </div>
      <div className="h-1 rounded-full bg-raised overflow-hidden">
        <div className={`h-full rounded-full ${barClass(window.percent)}`} style={{ width: `${Math.min(100, window.percent)}%` }} />
      </div>
    </div>
  );
}

export const PROVIDER_LABELS: Record<AgentProvider, string> = { claude: "Claude", codex: "Codex" };
