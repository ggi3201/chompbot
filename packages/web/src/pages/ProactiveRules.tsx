import { useState, useEffect, useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useCrud } from "../hooks/useCrud";
import { useGenerate } from "../hooks/useGenerate";
import { apiFetch } from "../lib/api";
import FormModal from "../components/FormModal";
import GenerateBar from "../components/GenerateBar";
import CodeEditor from "../components/CodeEditor";
import { ChevronRight, Plus, RefreshCw, Search, X } from "lucide-react";
import { Button, FilterPill, Input, PageHeader, Switch } from "../components/ui";
import type { RunTarget } from "@chomp/shared";
import { useAgentModels } from "../hooks/useAgentModels";
import RunTargetFields, { readRunTarget } from "../components/RunTargetFields";
import { formatDate, formatTimeAgo } from "../lib/format";
import { DiscordIcon, TelegramIcon } from "../components/ProviderIcons";
import {
  activeWindow,
  describeAction,
  describeTrigger,
  formatMinutes,
  guardNotes,
  lastResultByRule,
  ruleStatus,
  type RuleStatus,
} from "../lib/proactive";

interface ProactiveRule {
  id: string;
  name: string;
  triggerType: string;
  condition: unknown;
  actionType: string;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  cooldownMinutes: number;
  activeHours: Record<string, unknown>;
  priority: number;
  notificationChannels: string[];
  runAt?: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

interface RuleRun {
  id: string;
  ruleId: string;
  ruleName?: string | null;
  triggeredAt: string;
  triggerType: string;
  outcome: string;
  reason: string | null;
  outputPreview: string | null;
  durationMs: number | null;
  errorMessage: string | null;
}

interface Soul {
  id: string;
  name: string;
  isDefault: boolean;
}

const EVENT_TYPES = [
  "chat.message",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "schedule.completed",
  "schedule.failed",
  "service.health.changed",
  "user.active",
  "user.idle",
  "memory.saved",
  "webhook.received",
  "location.changed",
  "system.startup",
];

const CONDITION_OPS = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "contains", label: "contains" },
];

/** The one date format on this page, e.g. "3 Nov 2026, 14:05". */

const meta = "font-mono text-xs text-text-muted tabular-nums";


interface ConditionRow {
  field: string;
  op: string;
  value: string;
}

interface FormState {
  name: string;
  triggerType: string;
  eventType: string;
  conditions: ConditionRow[];
  actionType: string;
  notifyTitle: string;
  notifyBody: string;
  target: RunTarget;
  agentPrompt: string;
  scriptGateConfig: string;
  cooldownMinutes: string;
  jitterEnabled: boolean;
  jitterMinMinutes: string;
  jitterMaxMinutes: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  priority: string;
  notificationChannels: string[];
}

const NOTIFICATION_CHANNELS = [
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
];

const DEFAULT_SCRIPT_GATE_CONFIG = JSON.stringify({
  script: "market_quote_threshold",
  input: { ticker: "ACME", buyBelow: 55 },
  onTrue: {
    provider: "claude",
    prompt: "Gate fired:\n{{gateResult}}\nVerify context before notifying.",
  },
}, null, 2);

const EMPTY_FORM: FormState = {
  name: "",
  triggerType: "event",
  eventType: "",
  conditions: [],
  actionType: "notify",
  notifyTitle: "",
  notifyBody: "",
  target: {},
  agentPrompt: "",
  scriptGateConfig: DEFAULT_SCRIPT_GATE_CONFIG,
  cooldownMinutes: "60",
  jitterEnabled: false,
  jitterMinMinutes: "90",
  jitterMaxMinutes: "240",
  activeHoursStart: "",
  activeHoursEnd: "",
  priority: "0",
  notificationChannels: ["telegram"],
};

function ruleToForm(rule: ProactiveRule): FormState {
  const condition = (rule.condition ?? {}) as Record<string, unknown>;
  const conditions = (condition.conditions ?? []) as ConditionRow[];
  const actionConfig = rule.actionConfig ?? {};
  const activeHours = (rule.activeHours ?? {}) as Record<string, unknown>;

  return {
    name: rule.name,
    triggerType: rule.triggerType,
    eventType: (condition.eventType as string) ?? "",
    conditions,
    actionType: rule.actionType,
    notifyTitle: (actionConfig.title as string) ?? "",
    notifyBody: (actionConfig.body as string) ?? "",
    target: readRunTarget(actionConfig),
    agentPrompt: (actionConfig.prompt as string) ?? "",
    scriptGateConfig: rule.actionType === "script_gate" ? JSON.stringify(actionConfig, null, 2) : DEFAULT_SCRIPT_GATE_CONFIG,
    cooldownMinutes: String(rule.cooldownMinutes),
    jitterEnabled: condition.scheduleMode === "jittered",
    jitterMinMinutes: condition.jitterMinMinutes !== undefined ? String(condition.jitterMinMinutes) : "90",
    jitterMaxMinutes: condition.jitterMaxMinutes !== undefined ? String(condition.jitterMaxMinutes) : "240",
    activeHoursStart: activeHours.start !== undefined ? String(activeHours.start) : "",
    activeHoursEnd: activeHours.end !== undefined ? String(activeHours.end) : "",
    priority: String(rule.priority),
    notificationChannels: Array.isArray(rule.notificationChannels) ? rule.notificationChannels : ["telegram"],
  };
}

function formToData(form: FormState) {
  const condition: Record<string, unknown> = {};
  if (form.triggerType === "event") {
    if (form.eventType) condition.eventType = form.eventType;
    if (form.conditions.length > 0) {
      condition.conditions = form.conditions.filter((c) => c.field.trim());
    }
  } else if (form.jitterEnabled) {
    const min = Math.max(1, parseInt(form.jitterMinMinutes, 10) || 1);
    const max = Math.max(min, parseInt(form.jitterMaxMinutes, 10) || min);
    condition.scheduleMode = "jittered";
    condition.jitterMinMinutes = min;
    condition.jitterMaxMinutes = max;
  }

  const actionConfig: Record<string, unknown> = {};
  if (form.actionType === "notify") {
    if (form.notifyTitle) actionConfig.title = form.notifyTitle;
    if (form.notifyBody) actionConfig.body = form.notifyBody;
  } else if (form.actionType === "run_agent") {
    Object.assign(actionConfig, form.target);
    if (form.agentPrompt) actionConfig.prompt = form.agentPrompt;
  } else if (form.actionType === "script_gate") {
    Object.assign(actionConfig, JSON.parse(form.scriptGateConfig));
  }

  const activeHours: Record<string, unknown> = {};
  if (form.activeHoursStart !== "") activeHours.start = parseInt(form.activeHoursStart, 10);
  if (form.activeHoursEnd !== "") activeHours.end = parseInt(form.activeHoursEnd, 10);

  return {
    name: form.name,
    triggerType: form.triggerType,
    condition,
    actionType: form.actionType,
    actionConfig,
    cooldownMinutes: parseInt(form.cooldownMinutes, 10) || 60,
    activeHours,
    priority: parseInt(form.priority, 10) || 0,
    notificationChannels: form.notificationChannels,
  };
}

/** Color only for outcomes: fired is good, error is bad, every kind of skip stays neutral. */
const OUTCOME_TONE: Record<string, string> = {
  fired: "text-success",
  error: "text-error",
};

function OutcomeText({ outcome }: { outcome: string }) {
  const tone = OUTCOME_TONE[outcome] ?? "text-text-muted";
  return <span className={`font-mono text-xs whitespace-nowrap ${tone}`}>{outcome.replace(/_/g, " ")}</span>;
}

function runDetail(run: RuleRun): string | null {
  return run.reason ?? run.errorMessage ?? run.outputPreview ?? null;
}

const STATUS_DOT: Record<RuleStatus, string> = {
  ok: "bg-success",
  error: "bg-error",
  idle: "border border-text-muted/60",
};

const STATUS_LABEL: Record<RuleStatus, string> = {
  ok: "Last run fired",
  error: "Last run failed",
  idle: "No result yet",
};

function StatusDot({ status, className = "" }: { status: RuleStatus; className?: string }) {
  return <span role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status]} ${className}`} />;
}

function RuleHistory({ ruleId, refreshKey }: { ruleId: string; refreshKey: number }) {
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSkips, setShowSkips] = useState(false);

  useEffect(() => {
    apiFetch(`/proactive-rules/${ruleId}/runs`)
      .then((r) => r.json())
      .then((data: RuleRun[]) => setRuns(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ruleId, refreshKey]);

  if (loading) return <p className="text-[13px] text-text-muted">Loading runs</p>;
  const results = runs.filter((r) => r.outcome === "fired" || r.outcome === "error");
  const shown = (showSkips ? runs : results).slice(0, 10);
  const skipped = runs.length - results.length;

  return (
    <div className="flex flex-col gap-2">
      {shown.length === 0 ? (
        <p className="text-[13px] text-text-muted">{runs.length === 0 ? "No runs recorded yet" : "Nothing fired yet, only skips"}</p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          {shown.map((run) => (
            <div key={run.id} className="px-3 py-2.5 border-b border-border last:border-b-0 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <OutcomeText outcome={run.outcome} />
                <div className={`flex items-center gap-3 ${meta}`}>
                  {run.durationMs != null && <span>{run.durationMs}ms</span>}
                  <span>{formatDate(run.triggeredAt)}</span>
                </div>
              </div>
              {run.outputPreview && <p className="text-[13px] text-text-secondary leading-relaxed line-clamp-2">{run.outputPreview}</p>}
              {run.reason && <p className="text-[13px] text-text-muted leading-relaxed">{run.reason}</p>}
              {run.errorMessage && <p className="text-[13px] text-error leading-relaxed">{run.errorMessage}</p>}
            </div>
          ))}
        </div>
      )}
      {skipped > 0 && (
        <button type="button" onClick={() => setShowSkips((v) => !v)} className="self-start text-xs text-text-muted hover:text-text-secondary cursor-pointer">
          {showSkips ? "Hide skipped runs" : `Show ${skipped} skipped run${skipped > 1 ? "s" : ""}`}
        </button>
      )}
    </div>
  );
}

type LogFilter = "results" | "errors" | "skipped" | "all";

const LOG_FILTERS: Array<{ key: LogFilter; label: string; match: (outcome: string) => boolean }> = [
  { key: "results", label: "Fired and failed", match: (o) => o === "fired" || o === "error" },
  { key: "errors", label: "Errors", match: (o) => o === "error" },
  { key: "skipped", label: "Skipped", match: (o) => o !== "fired" && o !== "error" },
  { key: "all", label: "All", match: () => true },
];

function RunLogTable({ runs, loading }: { runs: RuleRun[]; loading: boolean }) {
  const [filter, setFilter] = useState<LogFilter>("results");

  if (loading && runs.length === 0) return <p className="text-[13px] text-text-muted py-8">Loading run log</p>;

  const active = LOG_FILTERS.find((f) => f.key === filter) ?? LOG_FILTERS[0];
  const shown = runs.filter((r) => active.match(r.outcome)).slice(0, 200);
  const th = "text-left px-4 h-10 border-b border-border text-[13px] text-text-muted font-normal";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {LOG_FILTERS.map((f) => (
          <FilterPill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} <span className="font-mono tabular-nums text-text-muted">{runs.filter((r) => f.match(r.outcome)).length}</span>
          </FilterPill>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-[13px] text-text-muted py-8">Nothing in this view</p>
      ) : (
        <div className="bg-glass rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <thead>
                <tr>
                  <th className={th}>Time</th>
                  <th className={th}>Rule</th>
                  <th className={th}>Outcome</th>
                  <th className={th}>Why or output</th>
                  <th className={`${th} text-right`}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((run) => {
                  const detail = runDetail(run);
                  return (
                    <tr key={run.id} className="border-b border-border last:border-b-0 align-top hover:bg-white/2">
                      <td className={`px-4 py-2.5 whitespace-nowrap ${meta}`}>{formatDate(run.triggeredAt)}</td>
                      <td className="px-4 py-2.5">
                        <div className="max-w-[240px]">
                          <p className="truncate text-sm text-text-secondary" title={run.ruleName ?? run.ruleId}>{run.ruleName ?? "Deleted rule"}</p>
                          <p className={`mt-1 ${meta}`}>{run.triggerType}</p>
                        </div>
                      </td>
                      <td className="px-4 py-2.5"><OutcomeText outcome={run.outcome} /></td>
                      <td className="px-4 py-2.5 text-[13px] text-text-secondary">
                        {detail ? <p className="max-w-[520px] whitespace-pre-wrap leading-relaxed">{detail}</p> : <span className="text-text-muted">No detail recorded</span>}
                      </td>
                      <td className={`px-4 py-2.5 text-right whitespace-nowrap ${meta}`}>{run.durationMs != null ? `${run.durationMs}ms` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface Feedback {
  ok: boolean;
  text: string;
}

interface RuleRowProps {
  rule: ProactiveRule;
  result: RuleRun | undefined;
  open: boolean;
  running: boolean;
  testing: boolean;
  feedback: Feedback | null;
  runsVersion: number;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
  onTest: () => void;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-secondary min-w-0">{children}</dd>
    </>
  );
}

const CHANNEL_ICONS: Record<string, typeof TelegramIcon> = { telegram: TelegramIcon, discord: DiscordIcon };

/** Brand marks for the channels a rule notifies; nothing when it only stays in its chat. */
function ChannelIcons({ channels, className = "" }: { channels: string[]; className?: string }) {
  const shown = NOTIFICATION_CHANNELS.filter((c) => channels.includes(c.value));
  if (shown.length === 0) return null;
  return (
    <span className={`flex items-center gap-1 ${className}`} title={`Sends to ${shown.map((c) => c.label).join(" and ")}`}>
      {shown.map((c) => {
        const Icon = CHANNEL_ICONS[c.value];
        return <Icon key={c.value} size={14} />;
      })}
      <span className="sr-only">Sends to {shown.map((c) => c.label).join(" and ")}</span>
    </span>
  );
}

function RuleRow({ rule, result, open, running, testing, feedback, runsVersion, onOpen, onToggle, onEdit, onDelete, onRun, onTest }: RuleRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = ruleStatus(result);
  const guards = guardNotes(rule);
  const hours = activeWindow(rule.activeHours);
  const prompt = typeof rule.actionConfig?.prompt === "string" ? rule.actionConfig.prompt : "";
  const last = result
    ? `${result.outcome === "error" ? "Failed" : "Fired"} ${formatTimeAgo(result.triggeredAt)}`
    : rule.lastTriggeredAt ? `Fired ${formatTimeAgo(rule.lastTriggeredAt)}` : "Never fired";

  return (
    <div className={`border-b border-border last:border-b-0 ${open ? "bg-white/2" : ""}`}>
      <div className="flex items-center gap-3 pl-4 pr-2">
        <Switch on={rule.enabled} label={`${rule.enabled ? "Pause" : "Enable"} ${rule.name}`} onChange={onToggle} />
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-center gap-3 py-3 pr-2 text-left cursor-pointer"
        >
          <div className="min-w-0 flex-1">
            <p className={`text-sm line-clamp-2 sm:line-clamp-1 ${rule.enabled ? "text-text-primary" : "text-text-secondary"}`}>{rule.name}</p>
            {!open && (
              <p className="mt-0.5 text-xs text-text-muted truncate">
                {[describeTrigger(rule), describeAction(rule), ...guards].join(" · ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ChannelIcons channels={rule.notificationChannels} className={rule.enabled ? "" : "opacity-40"} />
            <span className={`hidden sm:inline text-xs ${status === "error" ? "text-error" : "text-text-muted"}`}>{last}</span>
            <StatusDot status={status} className={rule.enabled ? "" : "opacity-40"} />
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className={`shrink-0 text-text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="pl-[64px] pr-4 pb-4 flex flex-col gap-4">
          <dl className="grid grid-cols-[72px_1fr] gap-x-4 gap-y-1.5 text-[13px] leading-relaxed">
            <Fact label="When">{describeTrigger(rule)}</Fact>
            <Fact label="Does">{describeAction(rule)}</Fact>
            {prompt && <Fact label="Prompt"><span className="line-clamp-3 whitespace-pre-wrap">{prompt}</span></Fact>}
            {guards.length > 0 && <Fact label="Only when">{guards.join(", ")}</Fact>}
            <Fact label="Limits">
              {rule.cooldownMinutes > 0 ? `once per ${formatMinutes(rule.cooldownMinutes)} at most` : "no cooldown"}
              {rule.priority > 0 ? ` · priority ${rule.priority}` : ""}
              {hours ? ` · active ${hours}` : ""}
            </Fact>
            <Fact label="Sends to">
              {rule.notificationChannels.length ? (
                <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                  {rule.notificationChannels.map((ch) => {
                    const Icon = CHANNEL_ICONS[ch];
                    return (
                      <span key={ch} className="inline-flex items-center gap-1.5">
                        {Icon && <Icon size={14} />}
                        {NOTIFICATION_CHANNELS.find((c) => c.value === ch)?.label ?? ch}
                      </span>
                    );
                  })}
                </span>
              ) : "nowhere"}
            </Fact>
            <Fact label="History"><span className={meta}>{rule.triggerCount} fired{rule.lastTriggeredAt ? `, last ${formatDate(rule.lastTriggeredAt)}` : ""}</span></Fact>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onRun} disabled={running}>{running ? "Running" : "Run now"}</Button>
            <Button size="sm" variant="outline" onClick={onTest} disabled={testing} title="Preview what it would send, without sending">{testing ? "Testing" : "Test"}</Button>
            <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
            <div className="ml-auto flex gap-2">
              {confirmDelete ? (
                <>
                  <Button size="sm" variant="danger" onClick={() => { setConfirmDelete(false); onDelete(); }}>Delete rule</Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>Delete</Button>
              )}
            </div>
          </div>

          {feedback && (
            <p role="status" className={`text-[13px] leading-relaxed whitespace-pre-wrap rounded-lg border px-3 py-2 ${feedback.ok ? "border-border bg-glass text-text-secondary" : "border-error/25 text-error"}`}>
              {feedback.text}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-text-muted">Recent runs</h3>
            <RuleHistory ruleId={rule.id} refreshKey={runsVersion} />
          </div>
        </div>
      )}
    </div>
  );
}

const labelCls = "flex flex-col gap-1 text-xs font-medium text-text-secondary";
const quickCls = "h-7 px-2 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-50";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-xs font-medium text-text-muted">{children}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function describeLimits(form: FormState): string {
  const parts: string[] = [];
  const cooldown = parseInt(form.cooldownMinutes, 10);
  if (cooldown > 0) {
    if (cooldown < 60) parts.push(`at most once every ${cooldown} min`);
    else if (cooldown === 60) parts.push("at most once per hour");
    else if (cooldown < 1440) {
      const h = Math.floor(cooldown / 60);
      const m = cooldown % 60;
      parts.push(`at most once every ${h}h${m > 0 ? ` ${m}m` : ""}`);
    } else if (cooldown === 1440) parts.push("at most once per day");
    else {
      const d = Math.floor(cooldown / 1440);
      const rem = cooldown % 1440;
      parts.push(`at most once every ${d}d${rem > 0 ? ` ${Math.floor(rem / 60)}h` : ""}`);
    }
  } else {
    parts.push("no cooldown");
  }

  if (form.triggerType === "periodic" && form.jitterEnabled) {
    parts.push(`randomized ${form.jitterMinMinutes || "?"}–${form.jitterMaxMinutes || "?"} min`);
  }

  const start = form.activeHoursStart;
  const end = form.activeHoursEnd;
  if (start !== "" || end !== "") {
    const s = start !== "" ? `${start}:00` : "0:00";
    const e = end !== "" ? `${end}:00` : "23:00";
    parts.push(`active ${s}–${e}`);
  } else {
    parts.push("active all day");
  }

  const prio = parseInt(form.priority, 10);
  if (prio > 0) parts.push(`priority ${prio}`);

  return parts.join(" · ");
}

function LimitsSummary({ form }: { form: FormState }) {
  return (
    <p className="font-mono text-xs text-text-muted leading-relaxed">
      {describeLimits(form)}
    </p>
  );
}

function parseLimitsPrompt(input: string): Partial<FormState> {
  const patch: Partial<FormState> = {};
  const lower = input.toLowerCase().trim();

  // Cooldown patterns
  const everyDay = lower.match(/once\s*(a|per)\s*day|daily|every\s*day|24\s*h/);
  const everyHour = lower.match(/once\s*(a|per)\s*hour|hourly|every\s*hour|60\s*min/);
  const everyNHours = lower.match(/every\s*(\d+)\s*h/);
  const everyNMin = lower.match(/every\s*(\d+)\s*min/);
  const noCooldown = lower.match(/no\s*cooldown|always|unlimited/);
  const randomRange = lower.match(/random(?:ly|ized)?\s*(?:every|between)?\s*(\d+)\s*(?:-|–|to)\s*(\d+)\s*min/);

  if (everyDay) patch.cooldownMinutes = "1440";
  else if (everyHour) patch.cooldownMinutes = "60";
  else if (everyNHours) patch.cooldownMinutes = String(parseInt(everyNHours[1], 10) * 60);
  else if (everyNMin) patch.cooldownMinutes = everyNMin[1];
  else if (noCooldown) patch.cooldownMinutes = "0";
  if (randomRange) {
    patch.jitterEnabled = true;
    patch.jitterMinMinutes = randomRange[1];
    patch.jitterMaxMinutes = randomRange[2];
    patch.cooldownMinutes = randomRange[1];
  }

  // Active hours patterns
  const timeRange = lower.match(/(\d{1,2})(?::00)?\s*[-–to]+\s*(\d{1,2})(?::00)?/);
  const morning = lower.match(/\bmorning\b/);
  const evening = lower.match(/\bevening\b/);
  const allDay = lower.match(/all\s*day|24\/7|anytime/);

  if (timeRange) {
    patch.activeHoursStart = timeRange[1];
    patch.activeHoursEnd = timeRange[2];
  } else if (morning) {
    patch.activeHoursStart = "7";
    patch.activeHoursEnd = "9";
  } else if (evening) {
    patch.activeHoursStart = "17";
    patch.activeHoursEnd = "21";
  } else if (allDay) {
    patch.activeHoursStart = "";
    patch.activeHoursEnd = "";
  }

  // Priority
  const highPrio = lower.match(/high\s*prio|important|urgent/);
  const lowPrio = lower.match(/low\s*prio/);
  const prioNum = lower.match(/prio(?:rity)?\s*(\d+)/);

  if (prioNum) patch.priority = prioNum[1];
  else if (highPrio) patch.priority = "10";
  else if (lowPrio) patch.priority = "1";

  return patch;
}

function LimitsPrompt({ onApply }: { onApply: (patch: Partial<FormState>) => void }) {
  const [input, setInput] = useState("");

  function handleApply() {
    if (!input.trim()) return;
    const patch = parseLimitsPrompt(input);
    if (Object.keys(patch).length > 0) {
      onApply(patch);
      setInput("");
    }
  }

  return (
    <div className="flex gap-2 items-center">
      <Input
        value={input}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && (e.preventDefault(), handleApply())}
        placeholder='e.g. "every morning 7-8, once per day"'
        className="flex-1"
      />
      <Button type="button" variant="ghost" size="sm" onClick={handleApply} disabled={!input.trim()}>
        Apply
      </Button>
    </div>
  );
}

export default function ProactiveRules() {
  const location = useLocation();
  const { items, loading, error, create, update, remove, refresh } = useCrud<ProactiveRule>("/proactive-rules");
  const { generate, loading: generating, error: genError } = useGenerate("proactive-rules");
  const providers = useAgentModels();
  const [souls, setSouls] = useState<Soul[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  const [dryRunning, setDryRunning] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<{ id: string; ok: boolean; preview?: string; error?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"rules" | "logs">("rules");
  const [formError, setFormError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsVersion, setRunsVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "paused" | "failing">("all");
  const [showPaused, setShowPaused] = useState(false);

  const loadRuns = useCallback(async () => {
    try {
      const res = await apiFetch("/proactive-rules/runs?limit=500");
      if (res.ok) setRuns(await res.json());
    } catch {
      // keep the runs we already have
    } finally {
      setRunsLoading(false);
      setRunsVersion((v) => v + 1);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const results = useMemo(() => lastResultByRule(runs), [runs]);

  useEffect(() => {
    apiFetch("/souls").then((r) => r.ok ? r.json() : []).then((d) => setSouls(d)).catch(() => {});
  }, []);

  useEffect(() => {
    const state = location.state as {
      prefillRule?: {
        name: string;
        triggerType: string;
        eventType: string;
        conditions: ConditionRow[];
      };
    } | null;
    if (state?.prefillRule) {
      const pf = state.prefillRule;
      setEditing(null);
      setForm({
        ...EMPTY_FORM,
        name: pf.name,
        triggerType: pf.triggerType,
        eventType: pf.eventType,
        conditions: pf.conditions ?? [],
      });
      setShowForm(true);
      window.history.replaceState({}, "");
    }
  }, [location.state]);

  async function handleTrigger(id: string) {
    setRunning(id);
    setRunResult(null);
    try {
      const res = await apiFetch(`/proactive-rules/${id}/trigger`, { method: "POST" });
      if (res.ok) {
        setRunResult({ id, ok: true });
      } else {
        const body = await res.json().catch(() => null);
        setRunResult({ id, ok: false, error: body?.error ?? `Failed (${res.status})` });
      }
      refresh();
      loadRuns();
    } catch (e) {
      setRunResult({ id, ok: false, error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setRunning(null);
    }
  }

  async function handleDryRun(id: string) {
    setDryRunning(id);
    setDryRunResult(null);
    try {
      const res = await apiFetch(`/proactive-rules/${id}/dry-run`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setDryRunResult({ id, ok: true, preview: body?.preview });
      } else {
        setDryRunResult({ id, ok: false, error: body?.error ?? `Failed (${res.status})` });
      }
    } catch (e) {
      setDryRunResult({ id, ok: false, error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setDryRunning(null);
    }
  }

  const [editing, setEditing] = useState<ProactiveRule | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(rule: ProactiveRule) {
    setEditing(rule);
    setForm(ruleToForm(rule));
    setFormError(null);
    setShowForm(true);
  }

  async function handleSubmit() {
    setFormError(null);
    let data: ReturnType<typeof formToData>;
    try {
      data = formToData(form);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Invalid rule form");
      return;
    }
    if (editing) {
      await update(editing.id, data as unknown as Partial<ProactiveRule>);
    } else {
      await create(data as unknown as Partial<ProactiveRule>);
    }
    setShowForm(false);
  }

  function updateCondition(index: number, patch: Partial<ConditionRow>) {
    setForm((f) => ({
      ...f,
      conditions: f.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function addCondition() {
    setForm((f) => ({ ...f, conditions: [...f.conditions, { field: "", op: "eq", value: "" }] }));
  }

  function removeCondition(index: number) {
    setForm((f) => ({ ...f, conditions: f.conditions.filter((_, i) => i !== index) }));
  }

  async function handleGenerate(prompt: string) {
    const result = await generate(prompt);
    if (!result) return;
    const r = result as Record<string, unknown>;
    const condition = (r.condition ?? {}) as Record<string, unknown>;
    const actionConfig = (r.actionConfig ?? {}) as Record<string, unknown>;
    const activeHours = (r.activeHours ?? {}) as Record<string, unknown>;

    setForm({
      name: (r.name as string) ?? "",
      triggerType: (r.triggerType as string) ?? "event",
      eventType: (condition.eventType as string) ?? "",
      conditions: (condition.conditions as ConditionRow[]) ?? [],
      actionType: (r.actionType as string) ?? "notify",
      notifyTitle: (actionConfig.title as string) ?? "",
      notifyBody: (actionConfig.body as string) ?? "",
      target: readRunTarget(actionConfig),
      agentPrompt: (actionConfig.prompt as string) ?? "",
      scriptGateConfig: (r.actionType as string) === "script_gate" ? JSON.stringify(actionConfig, null, 2) : DEFAULT_SCRIPT_GATE_CONFIG,
      cooldownMinutes: r.cooldownMinutes !== undefined ? String(r.cooldownMinutes) : "60",
      jitterEnabled: condition.scheduleMode === "jittered",
      jitterMinMinutes: condition.jitterMinMinutes !== undefined ? String(condition.jitterMinMinutes) : "90",
      jitterMaxMinutes: condition.jitterMaxMinutes !== undefined ? String(condition.jitterMaxMinutes) : "240",
      activeHoursStart: activeHours.start !== undefined ? String(activeHours.start) : "",
      activeHoursEnd: activeHours.end !== undefined ? String(activeHours.end) : "",
      priority: r.priority !== undefined ? String(r.priority) : "0",
      notificationChannels: Array.isArray(r.notificationChannels) ? (r.notificationChannels as string[]) : ["telegram"],
    });
  }

  // A paused rule that once failed is not "failing"; nothing is running.
  const statusOf = (r: ProactiveRule) => ruleStatus(results.get(r.id));
  const isFailing = (r: ProactiveRule) => r.enabled && statusOf(r) === "error";
  const counts = {
    all: items.length,
    on: items.filter((r) => r.enabled).length,
    paused: items.filter((r) => !r.enabled).length,
    failing: items.filter(isFailing).length,
  };
  const q = query.trim().toLowerCase();
  const matches = items.filter((r) => {
    if (q && !`${r.name} ${describeTrigger(r)} ${describeAction(r)}`.toLowerCase().includes(q)) return false;
    if (filter === "on") return r.enabled;
    if (filter === "paused") return !r.enabled;
    if (filter === "failing") return isFailing(r);
    return true;
  });
  const byName = (a: ProactiveRule, b: ProactiveRule) => a.name.localeCompare(b.name);
  // Failing rules float to the top of the live list so a broken rule is the first thing you see.
  const live = matches.filter((r) => r.enabled).sort((a, b) => Number(isFailing(b)) - Number(isFailing(a)) || byName(a, b));
  const paused = matches.filter((r) => !r.enabled).sort(byName);
  const pausedExpanded = showPaused || q !== "" || filter === "paused" || filter === "failing";

  function rowFor(rule: ProactiveRule) {
    const feedback: Feedback | null =
      runResult?.id === rule.id
        ? { ok: runResult.ok, text: runResult.ok ? "Ran it. The result shows under recent runs." : `Run failed: ${runResult.error}` }
        : dryRunResult?.id === rule.id
          ? { ok: dryRunResult.ok, text: dryRunResult.ok ? `Test preview:\n${dryRunResult.preview ?? "No output"}` : `Test failed: ${dryRunResult.error}` }
          : null;
    return (
      <RuleRow
        key={rule.id}
        rule={rule}
        result={results.get(rule.id)}
        open={openId === rule.id}
        running={running === rule.id}
        testing={dryRunning === rule.id}
        feedback={feedback}
        runsVersion={runsVersion}
        onOpen={() => {
          setRunResult(null);
          setDryRunResult(null);
          setOpenId(openId === rule.id ? null : rule.id);
        }}
        onToggle={(enabled) => update(rule.id, { enabled } as Partial<ProactiveRule>)}
        onEdit={() => openEdit(rule)}
        onDelete={() => { setOpenId(null); remove(rule.id); }}
        onRun={() => handleTrigger(rule.id)}
        onTest={() => handleDryRun(rule.id)}
      />
    );
  }

  return (
    <div className="p-6">
      <PageHeader title="Proactive rules" action={<Button onClick={openNew}>Add rule</Button>} />
      <div className="mb-6 flex items-center gap-1 border-b border-border">
        {[
          { key: "rules", label: "Rules" },
          { key: "logs", label: "Logs" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key as "rules" | "logs")}
            className={`h-9 px-3 -mb-px text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === tab.key
                ? "text-text-primary border-accent"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
        <Button type="button" variant="outline" size="sm" className="ml-auto mb-1" onClick={() => { refresh(); loadRuns(); }}>
          <RefreshCw size={16} strokeWidth={1.5} />
          Refresh
        </Button>
      </div>

      {activeTab === "rules" && (
        <div className="flex flex-col gap-4">
          {error && items.length > 0 && <p className="rounded-md border border-error/25 px-3 py-2 text-[13px] text-error">{error}</p>}
          {loading && items.length === 0 ? (
            <p className="text-[13px] text-text-muted py-8">Loading rules</p>
          ) : error && items.length === 0 ? (
            <p className="text-[13px] text-error py-8">{error}</p>
          ) : items.length === 0 ? (
            <div className="py-12 flex flex-col items-start gap-3">
              <p className="text-sm text-text-secondary">No rules yet.</p>
              <p className="text-[13px] text-text-muted max-w-md leading-relaxed">A rule watches for an event or a time and then notifies you or runs an agent. Describe it in plain words and Chomp drafts it.</p>
              <Button variant="primary" onClick={openNew}>Add the first rule</Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px] max-w-sm">
                  <Search size={16} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                  <Input
                    value={query}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                    placeholder="Search rules"
                    aria-label="Search rules"
                    className="w-full pl-9 h-9"
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ["all", "All"],
                    ["on", "On"],
                    ["paused", "Paused"],
                    ["failing", "Failing"],
                  ] as const).filter(([key]) => key !== "failing" || counts.failing > 0 || filter === "failing").map(([key, label]) => (
                    <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)}>
                      {label} <span className="font-mono tabular-nums text-text-muted">{counts[key]}</span>
                    </FilterPill>
                  ))}
                </div>
              </div>

              {matches.length === 0 && (
                <div className="py-10 flex flex-col items-start gap-2">
                  <p className="text-sm text-text-secondary">No rules match.</p>
                  <Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>Clear search and filters</Button>
                </div>
              )}

              {live.length > 0 && (
                <section className="bg-glass rounded-lg border border-border overflow-hidden">
                  <h3 className="px-4 h-9 flex items-center text-xs font-medium text-text-muted border-b border-border">
                    On <span className="ml-1.5 font-mono tabular-nums">{live.length}</span>
                  </h3>
                  {live.map(rowFor)}
                </section>
              )}

              {paused.length > 0 && (
                <section className="bg-glass rounded-lg border border-border overflow-hidden">
                  <h3>
                    <button
                      type="button"
                      onClick={() => setShowPaused((v) => !v)}
                      aria-expanded={pausedExpanded}
                      disabled={q !== "" || filter === "paused" || filter === "failing"}
                      className={`w-full px-4 h-9 flex items-center gap-1.5 text-xs font-medium text-text-muted ${pausedExpanded ? "border-b border-border" : ""} enabled:cursor-pointer enabled:hover:text-text-secondary`}
                    >
                      <ChevronRight size={14} strokeWidth={1.5} className={`transition-transform duration-150 ${pausedExpanded ? "rotate-90" : ""}`} />
                      Paused <span className="font-mono tabular-nums">{paused.length}</span>
                    </button>
                  </h3>
                  {pausedExpanded && paused.map(rowFor)}
                </section>
              )}
            </>
          )}
        </div>
      )}
      {activeTab === "logs" && <RunLogTable runs={runs} loading={runsLoading} />}

      <FormModal wide title={editing ? "Edit rule" : "New rule"} open={showForm} onClose={() => setShowForm(false)} onSubmit={handleSubmit}>
        {!editing && <GenerateBar loading={generating} error={genError} onGenerate={handleGenerate} />}
        {formError && <p className="rounded-md border border-error/25 px-3 py-2 text-[13px] text-error">{formError}</p>}
        <label className={labelCls}>
          Name
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Alert on service down" />
        </label>

        <label className={labelCls}>
          Trigger
          <Input as="select" value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })}>
            <option value="event">Event</option>
            <option value="periodic">Periodic</option>
          </Input>
        </label>
        <label className={labelCls}>
          Action
          <Input as="select" value={form.actionType} onChange={(e) => setForm({ ...form, actionType: e.target.value })}>
            <option value="notify">Notify</option>
            <option value="compose_message">AI brief</option>
            <option value="run_agent">Run agent</option>
            <option value="script_gate">Script gate</option>
          </Input>
        </label>

        {/* Event condition */}
        {form.triggerType === "event" && (
          <>
            <SectionLabel>When</SectionLabel>
            <label className={labelCls}>
              Event type
              <Input as="select" value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>
                <option value="">Any event</option>
                {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Input>
            </label>

            {form.conditions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-text-muted">Match all</span>
                {form.conditions.map((c, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <Input
                      className="flex-[2]"
                      placeholder="field"
                      value={c.field}
                      onChange={(e) => updateCondition(i, { field: e.target.value })}
                    />
                    <Input as="select" className="flex-[1.2]" value={c.op} onChange={(e) => updateCondition(i, { op: e.target.value })}>
                      {CONDITION_OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
                    </Input>
                    <Input
                      className="flex-[2]"
                      placeholder="value"
                      value={c.value}
                      onChange={(e) => updateCondition(i, { value: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => removeCondition(i)}
                      aria-label="Remove condition"
                      className="flex items-center justify-center w-8 h-8 shrink-0 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
                    >
                      <X size={16} strokeWidth={1.5} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={addCondition}>
                <Plus size={16} strokeWidth={1.5} />
                Add condition
              </Button>
            </div>
          </>
        )}

        {/* Action config */}
        {form.actionType === "notify" && (
          <>
            <SectionLabel>Notification</SectionLabel>
            <label className={labelCls}>
              Title
              <Input value={form.notifyTitle} onChange={(e) => setForm({ ...form, notifyTitle: e.target.value })} placeholder="Notification title" />
            </label>
            <label className={labelCls}>
              Body
              <Input as="textarea" className="min-h-[60px] resize-y" value={form.notifyBody} onChange={(e) => setForm({ ...form, notifyBody: e.target.value })} placeholder="Notification body" />
            </label>
          </>
        )}

        {form.actionType === "compose_message" && (
          <>
            <SectionLabel>AI brief</SectionLabel>
            <p className="text-xs text-text-muted">Generates a daily brief from schedules, activity and services.</p>
          </>
        )}

        {form.actionType === "run_agent" && (
          <>
            <SectionLabel>Runs as</SectionLabel>
            <RunTargetFields value={form.target} onChange={(target) => setForm({ ...form, target })} providers={providers} souls={souls} />
            <label className={labelCls}>
              Prompt
              <Input as="textarea" className="min-h-[120px] resize-y" value={form.agentPrompt} onChange={(e) => setForm({ ...form, agentPrompt: e.target.value })} placeholder="What should the agent do?" />
            </label>
          </>
        )}

        {form.actionType === "script_gate" && (
          <>
            <SectionLabel>Script gate</SectionLabel>
            <p className="text-xs text-text-muted leading-relaxed">
              Runs deterministic Chomp-native code first. The agent is delegated only when the gate returns true. Built-in script: <code>market_quote_threshold</code>; use <code>input.groups</code> for bounded AND setups.
            </p>
            <div className={labelCls}>
              <label htmlFor="gate-config">Gate config JSON</label>
              <CodeEditor
                id="gate-config"
                language="json"
                validate
                minHeight="220px"
                value={form.scriptGateConfig}
                onChange={(v) => setForm({ ...form, scriptGateConfig: v })}
                placeholder={DEFAULT_SCRIPT_GATE_CONFIG}
              />
            </div>
          </>
        )}

        {/* Notification channels */}
        <SectionLabel>Notify via</SectionLabel>
        <div className="flex gap-3">
          {NOTIFICATION_CHANNELS.map((ch) => {
            const checked = form.notificationChannels.includes(ch.value);
            return (
              <label key={ch.value} className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setForm((f) => {
                      const channels = checked
                        ? f.notificationChannels.filter((c) => c !== ch.value)
                        : [...f.notificationChannels, ch.value];
                      return { ...f, notificationChannels: channels };
                    });
                  }}
                  className="accent-accent"
                />
                {ch.label}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-text-muted">
          {form.notificationChannels.length === NOTIFICATION_CHANNELS.length
            ? "Notifications sent to all channels"
            : `Notifications sent to ${form.notificationChannels.join(", ")} only`}
        </p>

        {/* Schedule & limits */}
        <SectionLabel>Limits</SectionLabel>
        <LimitsSummary form={form} />
        <LimitsPrompt onApply={(patch) => setForm((f) => ({ ...f, ...patch }))} />
        <div className="flex gap-3">
          <label className={`${labelCls} flex-1`}>
            Cooldown (min)
            <Input type="number" value={form.cooldownMinutes} onChange={(e) => setForm({ ...form, cooldownMinutes: e.target.value })} min="0" />
          </label>
          <label className={`${labelCls} flex-1`}>
            Priority
            <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          </label>
        </div>
        {form.triggerType === "periodic" && (
          <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={form.jitterEnabled}
                onChange={(e) => setForm({ ...form, jitterEnabled: e.target.checked })}
                className="accent-accent"
              />
              Randomize wakeups after each run
            </label>
            {form.jitterEnabled && (
              <div className="flex gap-3">
                <label className={`${labelCls} flex-1`}>
                  Min interval (min)
                  <Input type="number" value={form.jitterMinMinutes} onChange={(e) => setForm({ ...form, jitterMinMinutes: e.target.value })} min="1" />
                </label>
                <label className={`${labelCls} flex-1`}>
                  Max interval (min)
                  <Input type="number" value={form.jitterMaxMinutes} onChange={(e) => setForm({ ...form, jitterMaxMinutes: e.target.value })} min="1" />
                </label>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-3">
          <label className={`${labelCls} flex-1`}>
            Active from (hour)
            <Input type="number" value={form.activeHoursStart} onChange={(e) => setForm({ ...form, activeHoursStart: e.target.value })} min="0" max="23" placeholder="0" />
          </label>
          <label className={`${labelCls} flex-1`}>
            Active until (hour)
            <Input type="number" value={form.activeHoursEnd} onChange={(e) => setForm({ ...form, activeHoursEnd: e.target.value })} min="0" max="23" placeholder="23" />
          </label>
        </div>
      </FormModal>
    </div>
  );
}
