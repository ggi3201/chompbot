/**
 * Proactive Engine — evaluates proactive rules on events and periodic checks.
 * Respects cooldowns, active hours, and rate limits.
 */
import { db } from "../db/index.js";
import { proactiveRules, proactiveRuleRuns, settings } from "../db/schema.js";
import { eq, and, gte } from "drizzle-orm";
import { randomUUID } from "crypto";
import { on } from "../events/bus.js";
import { notify } from "../notifications/router.js";
import { getAwarenessState } from "../awareness/state.js";
import type { ChompEvent } from "@chomp/shared";
import type { ChatOptions } from "../chat/handler.js";
import {
  parseStoredActionConfig,
  parseStoredActiveHours,
  parseStoredCondition,
  parseStoredNotificationChannels,
  type ActiveHours,
  type ActionConfig,
  type JitteredSchedule,
  type PeriodicCondition,
  type RuleCondition,
} from "./rule-model.js";
import { evaluateConditions } from "../lib/event-conditions.js";
import { explainScheduleGuard } from "./market-hours.js";
import { runScriptGate } from "./script-gates.js";

const PERIODIC_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Rate limiting: max proactive dispatches per hour (configurable via settings)
import { getGuardrail } from "../agents/registry.js";
import { runTargetFrom } from "../agents/run-target.js";
import { sendTurnNotice, type TurnNotice } from "../agents/turn-notice.js";
const dispatchTimestamps: number[] = [];

// In-memory per-rule execution lock. Prevents the same rule from running
// concurrently across overlapping ticks / event fan-out / manual triggers.
// Agents can run longer than PERIODIC_CHECK_INTERVAL_MS, so the next tick
// would otherwise see `lastTriggeredAt` still unset and fire the rule again.
const runningRuleIds = new Set<string>();

/** The machine's own zone (TZ or the OS setting), used until the user_timezone setting is set. */
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function getUserTimezone(): string {
  try {
    const row = db.select().from(settings).where(eq(settings.key, "user_timezone")).get();
    const value = row?.value?.trim();
    if (value) return value;
  } catch {
    // settings table unreachable — fall through to default
  }
  return DEFAULT_TIMEZONE;
}

function getHourInTimezone(tz: string, now: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
    const hour = parseInt(hourPart, 10);
    // Intl returns "24" for midnight in some locales — normalize.
    return Number.isFinite(hour) ? hour % 24 : new Date().getHours();
  } catch {
    // Invalid TZ — fall back to server local rather than throwing.
    return now.getHours();
  }
}

export function isWithinActiveHours(activeHours: ActiveHours): boolean {
  if (activeHours.start === undefined && activeHours.end === undefined) return true;
  const tz = activeHours.timezone || getUserTimezone();
  const hour = getHourInTimezone(tz);
  const start = activeHours.start ?? 0;
  const end = activeHours.end ?? 23;
  if (hour === start && activeHours.startMinute) {
    const minute = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, minute: "numeric" }).format(new Date()));
    if (minute < activeHours.startMinute) return false;
  }
  if (start <= end) {
    return hour >= start && hour <= end;
  }
  // Wraps around midnight (e.g., 22 to 6)
  return hour >= start || hour <= end;
}

function explainActiveHours(activeHours: ActiveHours): string | undefined {
  if (activeHours.start === undefined && activeHours.end === undefined) return undefined;
  const tz = activeHours.timezone || getUserTimezone();
  const hour = getHourInTimezone(tz);
  const start = activeHours.start ?? 0;
  const end = activeHours.end ?? 23;
  return `Active-hours guard blocked at ${String(hour).padStart(2, "0")}:00 ${tz}; allowed ${String(start).padStart(2, "0")}:00-${String(end).padStart(2, "0")}:00`;
}

function isInCooldown(rule: typeof proactiveRules.$inferSelect): boolean {
  if (rule.cooldownMinutes <= 0 || !rule.lastTriggeredAt) return false;
  const lastTriggered = new Date(rule.lastTriggeredAt).getTime();
  const cooldownMs = rule.cooldownMinutes * 60 * 1000;
  return Date.now() - lastTriggered < cooldownMs;
}

function explainCooldown(rule: typeof proactiveRules.$inferSelect): string {
  if (!rule.lastTriggeredAt) return `Cooldown ${rule.cooldownMinutes}m active`;
  const lastTriggered = new Date(rule.lastTriggeredAt).getTime();
  const cooldownMs = rule.cooldownMinutes * 60 * 1000;
  const remainingMs = Math.max(0, cooldownMs - (Date.now() - lastTriggered));
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  return `Cooldown ${rule.cooldownMinutes}m active; roughly ${remainingMinutes}m remaining`;
}

function getJitterDelayMs(condition: JitteredSchedule): number {
  const minMinutes = Math.max(1, Math.floor(condition.jitterMinMinutes ?? 60));
  const maxMinutes = Math.max(minMinutes, Math.floor(condition.jitterMaxMinutes ?? minMinutes));
  const rangeMinutes = maxMinutes - minMinutes;
  const delayMinutes = minMinutes + Math.floor(Math.random() * (rangeMinutes + 1));
  return delayMinutes * 60 * 1000;
}

function scheduleNextJitteredRun(rule: typeof proactiveRules.$inferSelect, condition: PeriodicCondition, baseTime = Date.now()): string {
  const nextRunAt = new Date(baseTime + getJitterDelayMs(condition)).toISOString();
  db.update(proactiveRules).set({
    condition: JSON.stringify({ ...condition, scheduleMode: "jittered", nextRunAt }),
    updatedAt: new Date().toISOString(),
  }).where(eq(proactiveRules.id, rule.id)).run();
  return nextRunAt;
}

function isJitteredRuleDue(rule: typeof proactiveRules.$inferSelect, condition: PeriodicCondition): boolean {
  if (condition.scheduleMode !== "jittered") return true;

  if (!condition.nextRunAt) {
    const nextRunAt = scheduleNextJitteredRun(rule, condition);
    console.log(`[proactive] Scheduled first jittered run for "${rule.name}" at ${nextRunAt}`);
    return false;
  }

  const nextRunAt = new Date(condition.nextRunAt).getTime();
  if (!Number.isFinite(nextRunAt)) {
    const rescheduledRunAt = scheduleNextJitteredRun(rule, condition);
    console.log(`[proactive] Rescheduled invalid jittered run for "${rule.name}" at ${rescheduledRunAt}`);
    return false;
  }

  return Date.now() >= nextRunAt;
}

function explainJitterNotDue(condition: PeriodicCondition): string {
  return condition.nextRunAt
    ? `Jittered schedule not due until ${condition.nextRunAt}`
    : "Jittered schedule initialized; waiting for the first randomized run";
}

function canDispatchProactively(): boolean {
  const oneHourAgo = Date.now() - 3600000;
  // Clean old timestamps
  while (dispatchTimestamps.length > 0 && dispatchTimestamps[0] < oneHourAgo) {
    dispatchTimestamps.shift();
  }
  return dispatchTimestamps.length < getGuardrail("max_dispatches_per_hour");
}

/**
 * Substitute event-context placeholders in a prompt template:
 *   {{payload}}        — JSON.stringify of event.payload (webhook body)
 *   {{payloadPreview}} — first 300 chars of payload JSON
 *   {{event}}          — full event JSON
 *   {{webhookId}}      — event.webhookId
 *   {{webhookName}}    — event.webhookName
 */
function injectEventContext(template: string, event?: ChompEvent): string {
  if (!event) return template;
  const ev = event as unknown as Record<string, unknown>;
  const payloadJson = JSON.stringify(ev.payload ?? {}, null, 2);
  const payloadPreview = payloadJson.length > 300 ? payloadJson.slice(0, 297) + "..." : payloadJson;
  const headers = (ev.headers ?? {}) as Record<string, string>;
  const githubEvent = headers["x-github-event"] ?? "";
  return template
    .replace(/\{\{payload\}\}/g, payloadJson)
    .replace(/\{\{payloadPreview\}\}/g, payloadPreview)
    .replace(/\{\{event\}\}/g, JSON.stringify(event, null, 2))
    .replace(/\{\{webhookId\}\}/g, String(ev.webhookId ?? ""))
    .replace(/\{\{webhookName\}\}/g, String(ev.webhookName ?? ""))
    .replace(/\{\{githubEvent\}\}/g, githubEvent)
    .replace(/\{\{headers\}\}/g, JSON.stringify(headers, null, 2));
}

function injectGateContext(template: string, gateResult: unknown): string {
  const resultJson = JSON.stringify(gateResult, null, 2);
  return template
    .replace(/\{\{gateResult\}\}/g, resultJson)
    .replace(/\{\{result\}\}/g, resultJson);
}

function actionString(config: ActionConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

async function dispatchAgentAction(
  rule: typeof proactiveRules.$inferSelect,
  actionConfig: ActionConfig,
  event: ChompEvent | undefined,
  opts: { skipRateLimit?: boolean; dryRun?: boolean } | undefined,
  promptOverride?: string,
): Promise<{ outputPreview?: string; skipped?: RunOutcome; reason?: string }> {
  if (opts?.dryRun) {
    const template = promptOverride ?? actionString(actionConfig, "prompt") ?? `Proactive rule "${rule.name}" triggered. ${event ? `Event: ${JSON.stringify(event)}` : ""}`;
    const prompt = injectEventContext(template, event);
    return { outputPreview: `[dry-run] Would dispatch agent "${actionString(actionConfig, "soulId") ?? actionString(actionConfig, "agent") ?? "(default)"}" on ${actionString(actionConfig, "provider") ?? "the default provider"} with prompt: ${prompt.slice(0, 300)}` };
  }

  if (!opts?.skipRateLimit && !canDispatchProactively()) {
    console.log(`[proactive] Rate limited: skipping agent dispatch for "${rule.name}"`);
    return { skipped: "skipped_rate_limit", reason: `Max proactive dispatches per hour reached (${getGuardrail("max_dispatches_per_hour")})` };
  }

  const { dispatchToAgent } = await import("../agents/dispatch.js");
  const { agentSessions, chatMessages, conversations } = await import("../db/schema.js");

  // Always create a fresh conversation — proactive runs must not resume a
  // prior CC/Codex session (which would happen if an existing conversation
  // with a stored ccSessionId/codexSessionId were reused).
  const now = new Date().toISOString();
  const convId = randomUUID();
  db.insert(conversations).values({
    id: convId,
    title: `Proactive: ${rule.name}`,
    createdAt: now,
    updatedAt: now,
  }).run();

  const template = promptOverride ?? actionString(actionConfig, "prompt") ?? `Proactive rule "${rule.name}" triggered. ${event ? `Event: ${JSON.stringify(event)}` : ""}`;
  const prompt = injectEventContext(template, event);

  const proactiveCtx = {
    conversationId: convId,
    send: () => {},
  };

  try {
    const notice: TurnNotice = {
      type: "agent-complete", title: rule.name, conversationId: convId, since: now, channels: parseStoredNotificationChannels(rule),
    };
    const dispatchOpts: ChatOptions = { deliveryChannel: "proactive", ...runTargetFrom(actionConfig), notifyWhenDone: notice };
    const label = actionString(actionConfig, "label");
    if (label) dispatchOpts.label = label;
    const routing = {
      action: "delegate" as const,
      agent: actionString(actionConfig, "agent"),
      prompt,
      reason: "proactive rule",
    };
    const result = await dispatchToAgent(
      routing,
      proactiveCtx,
      dispatchOpts,
    );
    dispatchTimestamps.push(Date.now());

    // chomp_reply saves to chatMessages but the onReply callbacks skip
    // proactive sessions (convId mismatch), so Discord/Telegram only get them from here.
    const body = await sendTurnNotice(notice, result.response);
    if (body) return { outputPreview: body };
  } catch (err) {
    console.error(`[proactive] Agent dispatch failed for "${rule.name}":`, err instanceof Error ? err.message : err);
    const messageCount = db.select().from(chatMessages).where(eq(chatMessages.conversationId, convId)).all().length;
    const sessionCount = db.select().from(agentSessions).where(eq(agentSessions.conversationId, convId)).all().length;
    if (messageCount === 0 && sessionCount === 0) {
      db.delete(conversations).where(eq(conversations.id, convId)).run();
    }
    throw err;
  }
  return {};
}

async function executeAction(
  rule: typeof proactiveRules.$inferSelect,
  event?: ChompEvent,
  opts?: { skipRateLimit?: boolean; dryRun?: boolean },
): Promise<{ outputPreview?: string; skipped?: RunOutcome; reason?: string }> {
  const actionConfig = parseStoredActionConfig(rule);
  const channels = parseStoredNotificationChannels(rule);

  switch (rule.actionType) {
    case "notify": {
      const title = injectEventContext(actionString(actionConfig, "title") ?? rule.name, event);
      const body = injectEventContext(actionString(actionConfig, "body") ?? (event ? JSON.stringify(event) : "Proactive notification"), event);
      if (!opts?.dryRun) {
        await notify({ type: "system", title, body, channels });
      }
      return { outputPreview: `[notify] ${title}: ${body}` };
    }

    case "compose_message": {
      const { composeDailyBrief } = await import("./daily-brief.js");
      const brief = await composeDailyBrief();
      if (!opts?.dryRun) {
        await notify({ type: "system", title: rule.name, body: brief, channels });
      }
      return { outputPreview: brief };
    }

    case "run_agent": {
      // Pre-dispatch hooks — run lightweight logic before burning an agent slot
      if (actionConfig.preDispatch === "github-issues") {
        const { triageGithubIssues } = await import("./github-issues.js");
        const triage = await triageGithubIssues();
        if (triage.issues.length === 0) {
          console.log(`[proactive] No GitHub issues to process for "${rule.name}"`);
          return { outputPreview: "[skipped] No GitHub issues to process" };
        }

        // Single issue — fall through to normal dispatch
        if (triage.issues.length === 1) {
          actionConfig.prompt = triage.issues[0].prompt;
          actionConfig.label = `Fix: ${triage.issues[0].issueRef}`;
        } else {
          // Multiple issues — dispatch an agent per issue in parallel
          if (opts?.dryRun) {
            const refs = triage.issues.map((i) => i.issueRef).join(", ");
            return { outputPreview: `[dry-run] Would dispatch ${triage.issues.length} agents for: ${refs}` };
          }

          const { dispatchToAgent } = await import("../agents/dispatch.js");
          const { agentSessions, chatMessages, conversations } = await import("../db/schema.js");
          const now = new Date().toISOString();
          const dispatched: string[] = [];

          await Promise.all(triage.issues.map(async (issue) => {
            if (!opts?.skipRateLimit && !canDispatchProactively()) {
              console.log(`[proactive] Rate limited: skipping agent dispatch for ${issue.issueRef}`);
              return;
            }

            // Always create a fresh conversation — proactive runs must not
            // resume a prior CC/Codex session (which would happen if an existing
            // conversation with a stored ccSessionId/codexSessionId were reused).
            const convId = randomUUID();
            db.insert(conversations).values({
              id: convId,
              title: `Proactive: ${rule.name} — ${issue.issueRef}`,
              createdAt: now,
              updatedAt: now,
            }).run();

            const proactiveCtx = { conversationId: convId, send: () => {} };
            const dispatchOpts: ChatOptions = { ...runTargetFrom(actionConfig), label: `Fix: ${issue.issueRef}` };

            try {
              const routing = {
                action: "delegate" as const,
                agent: actionString(actionConfig, "agent"),
                prompt: issue.prompt,
                reason: "proactive rule",
              };
              await dispatchToAgent(
                routing,
                proactiveCtx,
                dispatchOpts,
              );
              dispatchTimestamps.push(Date.now());
              dispatched.push(issue.issueRef);
            } catch (err) {
              console.error(`[proactive] Agent dispatch failed for ${issue.issueRef}:`, err instanceof Error ? err.message : err);
              const messageCount = db.select().from(chatMessages).where(eq(chatMessages.conversationId, convId)).all().length;
              const sessionCount = db.select().from(agentSessions).where(eq(agentSessions.conversationId, convId)).all().length;
              if (messageCount === 0 && sessionCount === 0) {
                db.delete(conversations).where(eq(conversations.id, convId)).run();
              }
            }
          }));

          const summary = dispatched.length > 0
            ? `Dispatched ${dispatched.length} agent(s): ${dispatched.join(", ")}`
            : "All dispatches were rate-limited or failed";
          console.log(`[proactive] ${summary}`);
          return { outputPreview: summary };
        }
      }

      if (actionConfig.preDispatch === "worktree-cleanup") {
        const { cleanupWorktrees } = await import("./worktree-cleanup.js");
        const result = await cleanupWorktrees();
        const summary = result.cleaned.length > 0
          ? `Cleaned ${result.cleaned.length} worktree(s):\n${result.cleaned.join("\n")}`
          : "No stale worktrees found";
        if (!opts?.dryRun && result.cleaned.length > 0) {
          await notify({ type: "system", title: "Worktree Cleanup", body: summary, channels });
        }
        if (result.errors.length > 0) {
          console.error("[proactive] Worktree cleanup errors:", result.errors);
        }
        return { outputPreview: summary };
      }

      return dispatchAgentAction(rule, actionConfig, event, opts);
    }

    case "script_gate": {
      const gateResult = await runScriptGate(actionConfig);
      if (!gateResult.matched) {
        console.log(`[proactive] Script gate skipped "${rule.name}": ${gateResult.summary}`);
        return { outputPreview: `[script_gate:false] ${gateResult.summary}`, skipped: "skipped_script_gate", reason: gateResult.summary };
      }

      const onTrue = actionConfig.onTrue && typeof actionConfig.onTrue === "object" && !Array.isArray(actionConfig.onTrue)
        ? actionConfig.onTrue as ActionConfig
        : {};
      const delegateConfig: ActionConfig = { ...actionConfig, ...onTrue };
      const template = actionString(delegateConfig, "prompt") ?? `Script gate matched for proactive rule "${rule.name}". Gate result:\n{{gateResult}}`;
      const prompt = injectGateContext(template, gateResult);
      return dispatchAgentAction(rule, delegateConfig, event, opts, prompt);
    }
  }
  return {};
}

type RunOutcome = "fired" | "skipped_cooldown" | "skipped_active_hours" | "skipped_guard" | "skipped_rate_limit" | "skipped_script_gate" | "error";

function writeRun(opts: {
  ruleId: string;
  triggerType: string;
  outcome: RunOutcome;
  reason?: string;
  outputPreview?: string;
  durationMs?: number;
  errorMessage?: string;
}): void {
  try {
    db.insert(proactiveRuleRuns).values({
      id: randomUUID(),
      ruleId: opts.ruleId,
      triggeredAt: new Date().toISOString(),
      triggerType: opts.triggerType,
      outcome: opts.outcome,
      reason: opts.reason?.slice(0, 500) ?? null,
      outputPreview: opts.outputPreview?.slice(0, 500) ?? null,
      durationMs: opts.durationMs ?? null,
      errorMessage: opts.errorMessage ?? null,
    }).run();
  } catch (err) {
    console.error("[proactive] Failed to write run record:", err instanceof Error ? err.message : err);
  }
}

function markTriggered(ruleId: string): void {
  const rule = db.select().from(proactiveRules).where(eq(proactiveRules.id, ruleId)).get();
  if (!rule) return;
  db.update(proactiveRules).set({
    lastTriggeredAt: new Date().toISOString(),
    triggerCount: rule.triggerCount + 1,
    updatedAt: new Date().toISOString(),
  }).where(eq(proactiveRules.id, ruleId)).run();
}

/** Evaluate event-triggered rules */
async function evaluateEventRules(event: ChompEvent): Promise<void> {
  const rules = db.select().from(proactiveRules).all()
    .filter((r) => r.enabled && r.triggerType === "event");

  for (const rule of rules) {
    const start = Date.now();
    try {
      if (runningRuleIds.has(rule.id)) {
        console.log(`[proactive] Skipping "${rule.name}" — previous run still in progress`);
        writeRun({ ruleId: rule.id, triggerType: "event", outcome: "skipped_cooldown", reason: "Previous run still in progress", errorMessage: "already running", durationMs: Date.now() - start });
        continue;
      }

      if (isInCooldown(rule)) {
        writeRun({ ruleId: rule.id, triggerType: "event", outcome: "skipped_cooldown", reason: explainCooldown(rule), durationMs: Date.now() - start });
        continue;
      }

      const parsedCondition = parseStoredCondition(rule);
      const guardReason = explainScheduleGuard(parsedCondition.guard);
      if (guardReason) {
        writeRun({ ruleId: rule.id, triggerType: "event", outcome: "skipped_guard", reason: guardReason, durationMs: Date.now() - start });
        continue;
      }

      const activeHours: ActiveHours = parseStoredActiveHours(rule);
      if (!isWithinActiveHours(activeHours)) {
        writeRun({ ruleId: rule.id, triggerType: "event", outcome: "skipped_active_hours", reason: explainActiveHours(activeHours), durationMs: Date.now() - start });
        continue;
      }

      const conditions: RuleCondition[] | null = (() => {
        if (parsedCondition.eventType && parsedCondition.eventType !== event.type) return null;
        return parsedCondition.conditions ?? [];
      })();
      if (conditions === null) continue;

      if (!evaluateConditions(event as unknown as Record<string, unknown>, conditions)) continue;

      console.log(`[proactive] Firing rule: "${rule.name}" on ${event.type}`);
      // Webhook payloads are now stored on receipt in routes/webhooks.ts,
      // before the event is emitted, so every consumer of the bus can read
      // them — not just this one. Storing it here as well was what hid the
      // gap: the proactive path worked, the event-trigger path silently did
      // not, and shared state owned by a single consumer is how that happens.

      runningRuleIds.add(rule.id);
      // Mark before execute so concurrent events see the cooldown immediately.
      markTriggered(rule.id);
      try {
        const { outputPreview, skipped, reason } = await executeAction(rule, event);
        writeRun({ ruleId: rule.id, triggerType: "event", outcome: skipped ?? "fired", reason, outputPreview, durationMs: Date.now() - start });
      } finally {
        runningRuleIds.delete(rule.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proactive] Error evaluating "${rule.name}":`, msg);
      writeRun({ ruleId: rule.id, triggerType: "event", outcome: "error", errorMessage: msg, durationMs: Date.now() - start });
    }
  }
}

/** Evaluate periodic rules */
async function evaluatePeriodicRules(): Promise<void> {
  // Skip rules with a runAt — those are one-offs from schedule_one_off and
  // belong exclusively to evaluateScheduledRules. schedule_one_off stores
  // them with triggerType "periodic" but sets runAt; without this exclusion
  // they fire on every 5-min tick until runAt is reached (cooldown is 0).
  const rules = db.select().from(proactiveRules).all()
    .filter((r) => r.enabled && r.triggerType === "periodic" && !r.runAt);

  for (const rule of rules) {
    const start = Date.now();
    try {
      const condition = parseStoredCondition(rule) as PeriodicCondition;

      if (runningRuleIds.has(rule.id)) {
        console.log(`[proactive] Skipping periodic "${rule.name}" — previous run still in progress`);
        writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: "skipped_cooldown", reason: "Previous run still in progress", errorMessage: "already running", durationMs: Date.now() - start });
        continue;
      }

      if (!isJitteredRuleDue(rule, condition)) {
        writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: "skipped_cooldown", reason: explainJitterNotDue(condition), durationMs: Date.now() - start });
        continue;
      }

      if (isInCooldown(rule)) {
        writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: "skipped_cooldown", reason: explainCooldown(rule), durationMs: Date.now() - start });
        continue;
      }

      const guardReason = explainScheduleGuard(condition.guard);
      if (guardReason) {
        writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: "skipped_guard", reason: guardReason, durationMs: Date.now() - start });
        continue;
      }

      const activeHours: ActiveHours = parseStoredActiveHours(rule);
      if (!isWithinActiveHours(activeHours)) {
        writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: "skipped_active_hours", reason: explainActiveHours(activeHours), durationMs: Date.now() - start });
        continue;
      }

      console.log(`[proactive] Firing periodic rule: "${rule.name}"`);
      runningRuleIds.add(rule.id);
      // Mark before execute so cooldown reflects the start time. Otherwise an
      // action that runs longer than the interval lets the next tick fire the
      // rule again before lastTriggeredAt is written.
      markTriggered(rule.id);
      try {
        const { outputPreview, skipped, reason } = await executeAction(rule);
        if (condition.scheduleMode === "jittered") {
          scheduleNextJitteredRun(rule, condition);
        }
        writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: skipped ?? "fired", reason, outputPreview, durationMs: Date.now() - start });
      } finally {
        runningRuleIds.delete(rule.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proactive] Error in periodic rule "${rule.name}":`, msg);
      writeRun({ ruleId: rule.id, triggerType: "periodic", outcome: "error", errorMessage: msg, durationMs: Date.now() - start });
    }
  }
}

/** Evaluate one-off scheduled rules (runAt) */
async function evaluateScheduledRules(): Promise<void> {
  const now = new Date();
  const rules = db.select().from(proactiveRules).all()
    .filter((r) => r.enabled && r.runAt);

  for (const rule of rules) {
    const runAt = new Date(rule.runAt!);
    if (now < runAt) continue;

    if (runningRuleIds.has(rule.id)) {
      console.log(`[proactive] Skipping scheduled "${rule.name}" — previous run still in progress`);
      continue;
    }

    const start = Date.now();
    runningRuleIds.add(rule.id);
    // Delete the one-off rule BEFORE running the action. If the action is slow
    // or the process restarts mid-run, the rule won't re-fire on the next tick.
    db.delete(proactiveRules).where(eq(proactiveRules.id, rule.id)).run();

    try {
      console.log(`[proactive] Firing scheduled rule: "${rule.name}" (runAt: ${rule.runAt})`);
      const { outputPreview, skipped, reason } = await executeAction(rule, undefined, { skipRateLimit: true });
      writeRun({ ruleId: rule.id, triggerType: "scheduled", outcome: skipped ?? "fired", reason, outputPreview, durationMs: Date.now() - start });
      console.log(`[proactive] Auto-deleted one-off rule: "${rule.name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proactive] Error in scheduled rule "${rule.name}":`, msg);
      writeRun({ ruleId: rule.id, triggerType: "scheduled", outcome: "error", errorMessage: msg, durationMs: Date.now() - start });
    } finally {
      runningRuleIds.delete(rule.id);
    }
  }
}

/** Manually trigger a rule (bypasses cooldown/active hours). Returns the action result. */
export async function triggerRule(ruleId: string): Promise<{ ok: boolean; error?: string }> {
  const rule = db.select().from(proactiveRules).where(eq(proactiveRules.id, ruleId)).get();
  if (!rule) return { ok: false, error: "Rule not found" };
  if (runningRuleIds.has(rule.id)) {
    return { ok: false, error: "Rule is already running" };
  }
  const start = Date.now();
  runningRuleIds.add(rule.id);
  try {
    const { outputPreview, skipped, reason } = await executeAction(rule, undefined, { skipRateLimit: true });
    // Don't call markTriggered — manual runs should not reset the cooldown for scheduled runs
    writeRun({ ruleId: rule.id, triggerType: "manual", outcome: skipped ?? "fired", reason, outputPreview, durationMs: Date.now() - start });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[proactive] Manual trigger failed for "${rule.name}":`, msg);
    writeRun({ ruleId: rule.id, triggerType: "manual", outcome: "error", errorMessage: msg, durationMs: Date.now() - start });
    return { ok: false, error: msg };
  } finally {
    runningRuleIds.delete(rule.id);
  }
}

/** Dry-run a rule: executes the action in sandboxed mode (no notify/agent dispatch). */
export async function dryRunRule(ruleId: string): Promise<{ ok: boolean; preview?: string; error?: string }> {
  const rule = db.select().from(proactiveRules).where(eq(proactiveRules.id, ruleId)).get();
  if (!rule) return { ok: false, error: "Rule not found" };
  try {
    const { outputPreview } = await executeAction(rule, undefined, { skipRateLimit: true, dryRun: true });
    return { ok: true, preview: outputPreview };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/** Push proactive messages to all connected WebSocket clients */
export function broadcastProactiveMessage(title: string, body: string): void {
  // This will be picked up by the WebSocket handler via the notification router
  notify({ type: "system", title, body }).catch(() => {});
}

/** Start the proactive engine */
export function startProactiveEngine(): void {
  // Subscribe to event bus for event-triggered rules
  on((event) => {
    evaluateEventRules(event).catch((err) =>
      console.error("[proactive] Unhandled error in event evaluation:", err),
    );
  });

  // Periodic + scheduled rule evaluation. Guard against overlapping ticks —
  // individual rule runs are guarded by runningRuleIds, but the tick itself
  // could still pile up if evaluation takes longer than the interval.
  let tickInFlight = false;
  setInterval(() => {
    if (tickInFlight) {
      console.log("[proactive] Skipping tick — previous evaluation still running");
      return;
    }
    tickInFlight = true;
    (async () => {
      try {
        await evaluatePeriodicRules();
        await evaluateScheduledRules();
      } catch (err) {
        console.error("[proactive] Unhandled error in tick:", err);
      } finally {
        tickInFlight = false;
      }
    })();
  }, PERIODIC_CHECK_INTERVAL_MS);

  console.log("[proactive] Engine started");
}
