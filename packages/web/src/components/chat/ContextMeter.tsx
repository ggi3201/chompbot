import { useEffect, useRef, useState } from "react";
import type { ContextUsage, ProviderUsage } from "@chomp/shared";
import { apiFetch } from "../../lib/api";
import { barClass, PROVIDER_LABELS, UsageBar } from "./UsageMeter";

/** The last reading per chat, so switching back shows the ring at once while a fresh one loads. */
const lastReadings = new Map<string, ContextUsage>();

/**
 * The chat's context use, read when the chat opens and whenever a turn ends,
 * which is when it changes. Null for a new chat and before its first agent turn.
 */
export function useContextUsage(conversationId: string | undefined, turnActive: boolean): ContextUsage | null {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!conversationId || turnActive) return;
    let cancelled = false;
    apiFetch(`/conversations/${conversationId}/context`)
      .then((res) => (res.ok ? (res.json() as Promise<ContextUsage | null>) : null))
      .then((value) => {
        if (cancelled || !value) return;
        lastReadings.set(conversationId, value);
        setVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, turnActive]);

  return conversationId ? lastReadings.get(conversationId) ?? null : null;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return String(tokens);
}

/** The window's fill and what fills it; the ring's popover and the info panel share it. */
export function ContextDetails({ usage }: { usage: ContextUsage }) {
  const categories = [...usage.categories].sort((a, b) => b.tokens - a.tokens);
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-3 text-[13px]">
          <span className="text-text-primary">
            {formatTokens(usage.usedTokens)} of {formatTokens(usage.maxTokens)} tokens
          </span>
          <span className="ml-auto font-mono text-xs text-text-secondary">{usage.percent}%</span>
        </div>
        <div className="h-1 rounded-full bg-raised overflow-hidden">
          <div className={`h-full rounded-full ${barClass(usage.percent)}`} style={{ width: `${Math.min(100, usage.percent)}%` }} />
        </div>
      </div>
      {categories.length > 0 ? (
        <div className="flex flex-col gap-1">
          {categories.map((category) => (
            <div key={category.name} className="flex items-baseline gap-3 text-[13px]">
              <span className="min-w-0 truncate text-text-secondary">{category.name}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-text-muted">{formatTokens(category.tokens)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-text-muted">Codex reports the total only.</div>
      )}
    </>
  );
}

/** A ring that fills with the window, small enough to sit in the composer row. */
function Ring({ percent }: { percent: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, percent) / 100) * circumference;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={`${filled} ${circumference}`} strokeLinecap="round" />
    </svg>
  );
}

const actionClass =
  "h-7 px-2.5 rounded-md border border-border bg-transparent text-[13px] text-text-primary cursor-pointer transition-colors hover:bg-raised";

/**
 * How full the chat's agent session is. Click for what fills it, the plan's
 * usage windows, and to compact it or hand the work off to a new chat. A new
 * chat has no context yet, so the ring shows the plan's tightest window.
 */
export default function ContextMeter({
  usage,
  plan,
  modelLabel,
  onCompact,
  onHandoff,
}: {
  usage: ContextUsage | null;
  plan?: ProviderUsage;
  modelLabel?: string;
  onCompact: () => void;
  onHandoff: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointer);
    return () => document.removeEventListener("pointerdown", handlePointer);
  }, [open]);

  const windows = plan?.available ? plan.windows : [];
  if (!usage && windows.length === 0) return null;
  const percent = usage?.percent ?? Math.max(...windows.map((w) => w.percent));

  return (
    // Not positioned: the popover anchors to the composer box, so it stays on screen with buttons to its right.
    <div ref={rootRef} className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={usage ? "Context and plan usage" : "Plan usage"}
        className={`flex items-center gap-1.5 h-7 px-2 rounded-md border-none font-mono text-xs cursor-pointer transition-colors ${
          open ? "bg-raised text-text-primary" : "bg-transparent text-text-muted hover:bg-raised hover:text-text-primary"
        } ${percent >= 80 ? "text-accent-ink" : ""}`}
      >
        <Ring percent={percent} />
        <span>{percent}%</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 z-30 w-[min(340px,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-glass shadow-modal p-3.5 flex flex-col gap-3">
          {usage && (
            <>
              <div className="text-xs text-text-muted">Context · {modelLabel ?? usage.model ?? usage.provider}</div>
              <ContextDetails usage={usage} />
            </>
          )}
          {plan && windows.length > 0 && (
            <>
              <div className={`text-xs text-text-muted ${usage ? "pt-2 border-t border-border" : ""}`}>Plan usage · {plan.plan ?? PROVIDER_LABELS[plan.provider]}</div>
              {windows.map((window) => (
                <UsageBar key={window.id} window={window} />
              ))}
            </>
          )}

          {usage && <div className="flex gap-2">
            {usage.provider === "claude" && (
              <button type="button" onClick={() => { setOpen(false); onCompact(); }} className={actionClass}>
                Compact
              </button>
            )}
            <button type="button" onClick={() => { setOpen(false); onHandoff(); }} className={actionClass}>
              Hand off to a new chat
            </button>
          </div>}
        </div>
      )}
    </div>
  );
}
