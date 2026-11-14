import type { ResearchPlanState } from "../hooks/useChat";
import { Search, BookOpen, Brain, CheckCircle2, XCircle, Loader2 } from "lucide-react";

const STATUS_CONFIG: Record<string, { icon: typeof Search; label: string; color: string }> = {
  pending: { icon: Loader2, label: "Queued", color: "text-text-muted" },
  searching: { icon: Search, label: "Searching", color: "text-text-secondary" },
  reading: { icon: BookOpen, label: "Reading pages", color: "text-text-secondary" },
  analyzing: { icon: Brain, label: "Analyzing", color: "text-text-secondary" },
  done: { icon: CheckCircle2, label: "Complete", color: "text-emerald-400" },
  error: { icon: XCircle, label: "Failed", color: "text-red-400" },
};

function FacetCard({ facet }: { facet: ResearchPlanState["facets"][0] }) {
  const config = STATUS_CONFIG[facet.status] ?? STATUS_CONFIG.pending;
  const Icon = config.icon;
  const isActive = facet.status === "searching" || facet.status === "reading" || facet.status === "analyzing";

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3 flex flex-col gap-1.5 min-h-[72px]">
      <div className="flex items-center gap-2">
        <Icon
          size={14}
          className={`${config.color} shrink-0 ${isActive ? "animate-spin" : ""}`}
          style={isActive && Icon !== Loader2 ? { animation: "pulse 1.5s ease-in-out infinite" } : undefined}
        />
        <span className="text-[0.75rem] font-heading font-semibold text-text-primary truncate">
          {facet.label}
        </span>
      </div>
      <span className={`text-[11px] font-body ${config.color}`}>
        {config.label}
      </span>
      {facet.status === "done" && facet.summary && (
        <p className="text-[11px] text-text-muted font-body leading-[1.4] line-clamp-2 mt-0.5">
          {facet.summary}
        </p>
      )}
      {facet.status === "error" && facet.error && (
        <p className="text-[11px] text-red-400/60 font-body leading-[1.4] mt-0.5">
          {facet.error}
        </p>
      )}
    </div>
  );
}

export default function ResearchProgress({ plan, onStop }: { plan: ResearchPlanState; onStop?: () => void }) {
  const completed = plan.facets.filter((f) => f.status === "done").length;
  const failed = plan.facets.filter((f) => f.status === "error").length;
  const total = plan.facets.length;
  const progress = ((completed + failed) / total) * 100;

  return (
    <div className="flex items-start gap-2.5 px-4 mb-4">
      {/* Pulsing research icon */}
      <div className="relative shrink-0 mt-0.5" style={{ width: 28, height: 28 }}>
        <div
          className="absolute inset-0 rounded-full flex items-center justify-center"
          style={{ background: "var(--color-raised)" }}
        >
          <Search size={14} strokeWidth={1.5} className="text-text-secondary" />
        </div>
        <div
          className="absolute inset-0 rounded-full"
          style={{
            border: "1.5px solid rgba(242,163,58,0.5)",
            animation: "spin 3s linear infinite",
            borderBottomColor: "transparent",
            borderRightColor: "transparent",
          }}
        />
      </div>

      <div className="flex flex-col gap-2 flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="text-[0.7rem] font-body text-cyan-300">
            Researching: {plan.query}
          </span>
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="px-2 py-px rounded-[6px] border border-white/12 bg-white/6 text-text-muted cursor-pointer text-[11px] font-body leading-[1.4]"
            >
              Stop
            </button>
          )}
        </div>

        {/* Facet grid */}
        <div className="grid grid-cols-2 gap-1.5 max-sm:grid-cols-1">
          {plan.facets.map((facet, i) => (
            <FacetCard key={i} facet={facet} />
          ))}
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1 rounded-full bg-white/8 overflow-hidden">
            <div
              className="h-full rounded-full transition-colors duration-500 ease-out"
              style={{
                width: `${progress}%`,
                background: "var(--color-accent)",
              }}
            />
          </div>
          <span className="text-[11px] text-text-muted font-body shrink-0">
            {completed}/{total} facets
          </span>
        </div>
      </div>
    </div>
  );
}
