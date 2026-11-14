// Plain-language descriptions of proactive rules, so the list can say what a rule does
// instead of showing raw trigger and action enums.

export interface RuleShape {
  triggerType: string;
  condition: unknown;
  actionType: string;
  actionConfig: Record<string, unknown>;
  cooldownMinutes: number;
  activeHours: Record<string, unknown>;
  notificationChannels: string[];
  runAt?: string | null;
}

export interface RunShape {
  ruleId: string;
  triggeredAt: string;
  outcome: string;
}

const pad = (h: number) => String(h).padStart(2, "0");

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  if (min < 1440) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(min / 1440);
  const h = Math.round((min % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function zoneName(tz: unknown): string {
  return typeof tz === "string" && tz ? (tz.split("/").pop() ?? tz).replace(/_/g, " ") : "";
}

/** "07:00–09:00", "09:00", or null when the rule may run at any hour. Hours are inclusive on both ends. */
export function activeWindow(activeHours: Record<string, unknown>): string | null {
  const start = typeof activeHours.start === "number" ? activeHours.start : null;
  const end = typeof activeHours.end === "number" ? activeHours.end : null;
  if (start === null && end === null) return null;
  const from = start ?? 0;
  const to = end ?? 23;
  if (from === 0 && to === 23) return null;
  const tz = zoneName(activeHours.timezone);
  const span = from === to ? `${pad(from)}:00` : `${pad(from)}:00–${pad(to + 1)}:00`;
  return tz ? `${span} ${tz}` : span;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** How often a periodic rule fires, e.g. "Daily 07:00–09:00" or "Hourly 15:00–22:00 New York". */
export function describeCadence(rule: RuleShape): string {
  const condition = asRecord(rule.condition);
  const window = activeWindow(rule.activeHours);
  let rhythm: string;

  if (rule.runAt) {
    rhythm = `Once, ${new Date(rule.runAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    return rhythm;
  }
  if (condition.scheduleMode === "jittered") {
    rhythm = `Every ${formatMinutes(Number(condition.jitterMinMinutes) || 1)}–${formatMinutes(Number(condition.jitterMaxMinutes) || 1)}`;
  } else if (rule.cooldownMinutes >= 1300) {
    const days = Math.round(rule.cooldownMinutes / 1440);
    rhythm = days <= 1 ? "Daily" : days === 7 ? "Weekly" : `Every ${days} days`;
  } else if (rule.cooldownMinutes === 60) {
    rhythm = "Hourly";
  } else if (rule.cooldownMinutes > 0) {
    rhythm = `Every ${formatMinutes(rule.cooldownMinutes)}`;
  } else {
    rhythm = "Every check";
  }
  return window ? `${rhythm} · ${window}` : rhythm;
}

/** What starts the rule: the cadence for periodic rules, the event for event rules. */
export function describeTrigger(rule: RuleShape): string {
  if (rule.triggerType !== "event") return describeCadence(rule);
  const condition = asRecord(rule.condition);
  const filters = Array.isArray(condition.conditions) ? condition.conditions.length : 0;
  const event = typeof condition.eventType === "string" && condition.eventType ? condition.eventType : "any event";
  return filters ? `On ${event} · ${filters} filter${filters > 1 ? "s" : ""}` : `On ${event}`;
}

/** Guards that keep a rule quiet outside its session, e.g. ["XNAS open"]. */
export function guardNotes(rule: RuleShape): string[] {
  const guard = asRecord(asRecord(rule.condition).guard);
  const rules = Array.isArray(guard.rules) ? guard.rules : [];
  return rules.map((g) => {
    const r = asRecord(g);
    if (r.type === "market_session") return `${String(r.market ?? "market")} ${r.phase === "after_close" ? "after close" : "open"}`;
    return String(r.type ?? "guard").replace(/_/g, " ");
  });
}

export function describeAction(rule: RuleShape): string {
  const cfg = rule.actionConfig ?? {};
  switch (rule.actionType) {
    case "notify": return "Notify";
    case "compose_message": return "AI brief";
    case "script_gate": return cfg.script ? `Gate: ${String(cfg.script).replace(/_/g, " ")}` : "Script gate";
    case "run_agent": {
      return typeof cfg.model === "string" && cfg.model ? `Agent · ${cfg.model}` : "Agent";
    }
    default: return rule.actionType;
  }
}

/** Latest fired or failed run per rule; skips are noise and must not hide an earlier error. Input order does not matter. */
export function lastResultByRule<T extends RunShape>(runs: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const run of runs) {
    if (run.outcome !== "fired" && run.outcome !== "error") continue;
    const seen = latest.get(run.ruleId);
    if (!seen || run.triggeredAt > seen.triggeredAt) latest.set(run.ruleId, run);
  }
  return latest;
}

export type RuleStatus = "ok" | "error" | "idle";

/** error if the latest result failed, ok if it fired, idle if the rule has no result yet. */
export function ruleStatus(result: RunShape | undefined): RuleStatus {
  if (!result) return "idle";
  return result.outcome === "error" ? "error" : "ok";
}
