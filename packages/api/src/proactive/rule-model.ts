import { z } from "zod";
import type { proactiveRules } from "../db/schema.js";
import type { NotificationChannel } from "../notifications/router.js";
import type { FieldCondition } from "../lib/event-conditions.js";

export type ProactiveRuleRow = typeof proactiveRules.$inferSelect;

export type ProactiveTriggerType = "event" | "periodic";
export type ProactiveActionType = "notify" | "compose_message" | "run_agent" | "script_gate";

/** Re-export of the shared condition shape for legacy callers. */
export type RuleCondition = FieldCondition;

export interface ActiveHours {
  start?: number;
  startMinute?: number;
  end?: number;
  timezone?: string;
}

export interface JitteredSchedule {
  scheduleMode?: "fixed" | "jittered";
  jitterMinMinutes?: number;
  jitterMaxMinutes?: number;
  nextRunAt?: string;
}

export type MarketCode = "NYSE" | "NASDAQ" | "OSLO" | "XNYS" | "XNAS" | "XOSL";
export type MarketSchedulePhase = "regular" | "after_close" | "trading_day";

export interface MarketSessionGuardRule {
  type: "market_session";
  market: MarketCode;
  phase?: MarketSchedulePhase;
}

export interface DateRangeGuardRule {
  type: "date_range";
  startsAt?: string;
  endsAt?: string;
}

export interface WeekdayGuardRule {
  type: "weekday";
  timezone?: string;
  days: Array<"Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun">;
}

export type ScheduleGuardRule = MarketSessionGuardRule | DateRangeGuardRule | WeekdayGuardRule;

export interface ScheduleGuard {
  mode?: "all" | "any";
  rules: ScheduleGuardRule[];
}

export type PeriodicCondition = {
  conditions?: RuleCondition[];
  guard?: ScheduleGuard;
} & JitteredSchedule;

export type EventCondition = {
  eventType?: string;
  conditions?: RuleCondition[];
  guard?: ScheduleGuard;
};

export type RuleConditionPayload = EventCondition & PeriodicCondition;
export type JsonPrimitive = string | number | boolean;
export type JsonValue = JsonPrimitive | null | JsonValue[] | { [key: string]: JsonValue };
export type ActionConfig = Record<string, JsonValue>;

export interface ParsedProactiveRule extends Omit<ProactiveRuleRow, "condition" | "actionConfig" | "activeHours" | "notificationChannels"> {
  triggerType: ProactiveTriggerType;
  condition: RuleConditionPayload;
  actionType: ProactiveActionType;
  actionConfig: ActionConfig;
  activeHours: ActiveHours;
  notificationChannels: NotificationChannel[];
}

export type CreateProactiveRuleInput = {
  name: string;
  triggerType: ProactiveTriggerType;
  condition: RuleConditionPayload;
  actionType: ProactiveActionType;
  actionConfig: ActionConfig;
  enabled: boolean;
  cooldownMinutes: number;
  activeHours: ActiveHours;
  priority: number;
  notificationChannels: NotificationChannel[];
  runAt: string | null;
};

export type UpdateProactiveRuleInput = Partial<CreateProactiveRuleInput>;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string; details: string[] };

const triggerTypeSchema = z.enum(["event", "periodic"]);
const actionTypeSchema = z.enum(["notify", "compose_message", "run_agent", "script_gate"]);
const notificationChannelSchema = z.enum(["telegram", "discord"]);

const ruleConditionSchema = z.object({
  field: z.string().trim().min(1),
  op: z.enum(["eq", "neq", "contains"]),
  value: z.union([z.string(), z.number(), z.boolean()]).transform(String),
});

const marketSessionGuardRuleSchema = z.object({
  type: z.literal("market_session"),
  market: z.enum(["NYSE", "NASDAQ", "OSLO", "XNYS", "XNAS", "XOSL"]),
  phase: z.enum(["regular", "after_close", "trading_day"]).default("regular"),
});

const dateRangeGuardRuleSchema = z.object({
  type: z.literal("date_range"),
  startsAt: z.string().trim().min(1).optional(),
  endsAt: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.startsAt === undefined && value.endsAt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startsAt"],
      message: "date_range guard requires startsAt or endsAt",
    });
  }
  for (const key of ["startsAt", "endsAt"] as const) {
    if (value[key] !== undefined && Number.isNaN(Date.parse(value[key]))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be a valid datetime`,
      });
    }
  }
});

const weekdayGuardRuleSchema = z.object({
  type: z.literal("weekday"),
  timezone: z.string().trim().min(1).optional(),
  days: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1),
});

const scheduleGuardRuleSchema = z.union([
  marketSessionGuardRuleSchema,
  dateRangeGuardRuleSchema,
  weekdayGuardRuleSchema,
]);

const scheduleGuardSchema = z.object({
  mode: z.enum(["all", "any"]).default("all"),
  rules: z.array(scheduleGuardRuleSchema).min(1),
});

const activeHoursSchema = z.object({
  start: z.number().int().min(0).max(23).optional(),
  /** Holds the window shut until this minute of the start hour, for a 09:15 kind of start. */
  startMinute: z.number().int().min(0).max(59).optional(),
  end: z.number().int().min(0).max(23).optional(),
  timezone: z.string().trim().min(1).optional(),
}).passthrough();

const conditionSchema = z.object({
  eventType: z.string().trim().min(1).optional(),
  conditions: z.array(ruleConditionSchema).optional(),
  scheduleMode: z.enum(["fixed", "jittered"]).optional(),
  jitterMinMinutes: z.number().int().min(1).optional(),
  jitterMaxMinutes: z.number().int().min(1).optional(),
  nextRunAt: z.string().trim().min(1).optional(),
  guard: scheduleGuardSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if (
    value.jitterMinMinutes !== undefined &&
    value.jitterMaxMinutes !== undefined &&
    value.jitterMaxMinutes < value.jitterMinMinutes
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["jitterMaxMinutes"],
      message: "jitterMaxMinutes must be greater than or equal to jitterMinMinutes",
    });
  }
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const actionConfigSchema = z.record(jsonValueSchema)
  .transform((value) => {
    const result: ActionConfig = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null) continue;
      result[key] = typeof item === "object" ? item as JsonValue : String(item);
    }
    return result;
  });

const channelsSchema = z.array(notificationChannelSchema);

const createRuleSchema = z.object({
  name: z.string().trim().min(1),
  triggerType: triggerTypeSchema,
  condition: conditionSchema.default({}),
  actionType: actionTypeSchema,
  actionConfig: actionConfigSchema.default({}),
  enabled: z.boolean().default(true),
  cooldownMinutes: z.number().int().min(0).default(60),
  activeHours: activeHoursSchema.default({}),
  priority: z.number().int().default(0),
  notificationChannels: channelsSchema.default(["telegram"]),
  runAt: z.string().trim().min(1).nullable().default(null),
});

const updateRuleSchema = createRuleSchema.partial();

function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
    return `${path}: ${issue.message}`;
  });
}

function validationError(error: z.ZodError): ValidationResult<never> {
  return {
    ok: false,
    error: "Invalid proactive rule payload",
    details: formatZodError(error),
  };
}

export function validateCreateProactiveRule(input: unknown): ValidationResult<CreateProactiveRuleInput> {
  const parsed = createRuleSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return { ok: true, value: parsed.data };
}

export function validateUpdateProactiveRule(input: unknown): ValidationResult<UpdateProactiveRuleInput> {
  const parsed = updateRuleSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return { ok: true, value: parsed.data };
}

function parseStoredJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseStored<T>(schema: z.ZodSchema<T>, value: string, fallback: T): T {
  const parsed = schema.safeParse(parseStoredJson(value, fallback));
  return parsed.success ? parsed.data as T : fallback;
}

export function parseStoredCondition(rule: ProactiveRuleRow): RuleConditionPayload {
  return parseStored<RuleConditionPayload>(conditionSchema as z.ZodSchema<RuleConditionPayload>, rule.condition, {});
}

export function parseStoredActiveHours(rule: ProactiveRuleRow): ActiveHours {
  return parseStored<ActiveHours>(activeHoursSchema as z.ZodSchema<ActiveHours>, rule.activeHours, {});
}

export function parseStoredActionConfig(rule: ProactiveRuleRow): ActionConfig {
  return parseStored<ActionConfig>(actionConfigSchema as z.ZodSchema<ActionConfig>, rule.actionConfig, {});
}

export function parseStoredNotificationChannels(rule: ProactiveRuleRow): NotificationChannel[] {
  return parseStored(channelsSchema, rule.notificationChannels, ["telegram"]);
}

export function parseStoredProactiveRule(rule: ProactiveRuleRow): ParsedProactiveRule {
  const triggerType = triggerTypeSchema.safeParse(rule.triggerType);
  const actionType = actionTypeSchema.safeParse(rule.actionType);

  return {
    ...rule,
    triggerType: triggerType.success ? triggerType.data : "periodic",
    condition: parseStoredCondition(rule),
    actionType: actionType.success ? actionType.data : "run_agent",
    actionConfig: parseStoredActionConfig(rule),
    activeHours: parseStoredActiveHours(rule),
    notificationChannels: parseStoredNotificationChannels(rule),
  };
}
