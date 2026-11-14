import type { EntitySchema } from "./index.js";

export const proactiveRuleSchema: EntitySchema = {
  name: "proactive-rules",
  title: "Proactive Rule",
  description:
    "Automatically fires actions in response to system events or on a periodic schedule. " +
    "Use cases: alerting when services go down, composing daily AI briefs, running agents on events.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short descriptive name, e.g. 'Alert on service down'" },
      triggerType: {
        type: "string",
        enum: ["event", "periodic"],
        description: "'event' fires on a system event, 'periodic' fires on a timer (controlled by cooldownMinutes)",
      },
      condition: {
        type: "object",
        description:
          "For event triggers: which event and optional field conditions. For periodic: leave empty {} for every-day scheduling, set scheduleMode: 'jittered' with jitterMinMinutes/jitterMaxMinutes, or add a data-driven guard that must pass before firing.",
        properties: {
          eventType: {
            type: "string",
            enum: [
              "chat.message", "agent.started", "agent.completed", "agent.failed",
              "schedule.completed", "schedule.failed", "service.health.changed",
              "user.active", "user.idle", "memory.saved", "webhook.received", "location.changed", "system.startup",
            ],
            description: "The system event type that triggers this rule",
          },
          conditions: {
            type: "array",
            description: "Field-level conditions that must ALL match on the event payload",
            items: {
              type: "object",
              properties: {
                field: { type: "string", description: "Dot-path on event payload, e.g. 'newStatus'" },
                op: { type: "string", enum: ["eq", "neq", "contains"] },
                value: { type: "string" },
              },
              required: ["field", "op", "value"],
            },
          },
          scheduleMode: {
            type: "string",
            enum: ["fixed", "jittered"],
            description: "For periodic rules, 'jittered' schedules the next run randomly after each firing.",
          },
          jitterMinMinutes: {
            type: "integer",
            minimum: 1,
            description: "For jittered periodic rules, lower bound for the randomized interval.",
          },
          jitterMaxMinutes: {
            type: "integer",
            minimum: 1,
            description: "For jittered periodic rules, upper bound for the randomized interval.",
          },
          guard: {
            type: "object",
            description:
              "Optional extra gate. Omit for default every-day behavior. Shape: {mode:'all'|'any', rules:[...]}. Supported rules: market_session, weekday, date_range.",
            properties: {
              mode: { type: "string", enum: ["all", "any"], default: "all" },
              rules: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["market_session", "weekday", "date_range"] },
                  },
                },
              },
            },
          },
        },
      },
      actionType: {
        type: "string",
        enum: ["notify", "compose_message", "run_agent", "script_gate"],
        description: "'notify' sends a notification, 'compose_message' generates an AI brief, 'run_agent' runs a named agent, 'script_gate' runs deterministic built-in logic and delegates only if it returns true",
      },
      actionConfig: {
        type: "object",
        description: "For notify: {title, body}. For run_agent: {prompt, soulId?, provider?, model?, effort?}. For script_gate: {script, input, onTrue:{agent,prompt}}. Built-in script: market_quote_threshold.",
        properties: {
          title: { type: "string", description: "Notification title (notify action)" },
          body: { type: "string", description: "Notification body (notify action)" },
          soulId: { type: "string", description: "Which agent answers (run_agent action). MUST be a soulId from availableAgents, or omit for the default." },
          provider: { type: "string", enum: ["claude", "codex"], description: "Provider to run on (run_agent action). Omit for the default." },
          model: { type: "string", description: "Model of that provider (run_agent action). Omit for the provider default." },
          effort: { type: "string", description: "Reasoning effort (run_agent action). Omit for the model default." },
          prompt: { type: "string", description: "Instructions for the agent (run_agent action)" },
          script: { type: "string", enum: ["market_quote_threshold"], description: "Built-in deterministic gate runner (script_gate action)" },
          input: { type: "object", description: "Script input. For market_quote_threshold use {ticker, buyBelow}, {ticker, rules:[{label, field, op, value}]} for OR thresholds, or {ticker, groups:[{label, conditions:[{field, op, value}]}]} for bounded/AND setups." },
          onTrue: { type: "object", description: "Delegation config used when the script gate matches. Supports agent, agentId, model, prompt, soulId." },
        },
      },
      cooldownMinutes: { type: "integer", description: "Minimum minutes between triggers. Default 60.", default: 60 },
      activeHours: {
        type: "object",
        description:
          "Restrict when the rule fires. Hours are evaluated in `timezone` (or the user_timezone setting, else the server's own zone). Omit or {} for 24/7.",
        properties: {
          start: { type: "integer", minimum: 0, maximum: 23, description: "Start hour (0-23) in the configured timezone" },
          end: { type: "integer", minimum: 0, maximum: 23, description: "End hour (0-23) in the configured timezone" },
          timezone: {
            type: "string",
            description:
              "IANA timezone for evaluating start/end (e.g. 'Europe/Oslo'). Optional — falls back to the user_timezone setting, then Europe/Oslo.",
          },
        },
      },
      priority: { type: "integer", description: "Higher = more important. Default 0.", default: 0 },
    },
    required: ["name", "triggerType", "actionType"],
  },
  dynamicContext: ["agents", "eventTypes"],
  examples: [
    {
      name: "Alert on service down",
      triggerType: "event",
      condition: { eventType: "service.health.changed", conditions: [{ field: "newStatus", op: "eq", value: "down" }] },
      actionType: "notify",
      actionConfig: { title: "Service Down", body: "A connected service is now unreachable." },
      cooldownMinutes: 30,
      activeHours: {},
      priority: 5,
    },
    {
      name: "Morning brief",
      triggerType: "periodic",
      condition: {},
      actionType: "compose_message",
      actionConfig: {},
      cooldownMinutes: 720,
      activeHours: { start: 7, end: 9 },
      priority: 1,
    },
    {
      name: "Random Chomp heartbeat",
      triggerType: "periodic",
      condition: { scheduleMode: "jittered", jitterMinMinutes: 90, jitterMaxMinutes: 240 },
      actionType: "run_agent",
      actionConfig: { provider: "claude", prompt: "Check if anything needs attention; only notify me if useful." },
      cooldownMinutes: 90,
      activeHours: { start: 9, end: 21 },
      priority: 1,
    },
    {
      name: "ACME deterministic buy gate",
      triggerType: "periodic",
      condition: { guard: { rules: [{ type: "market_session", market: "XNYS", phase: "regular" }] } },
      actionType: "script_gate",
      actionConfig: {
        script: "market_quote_threshold",
        input: { ticker: "ACME", buyBelow: 55 },
        onTrue: {
          provider: "claude",
          prompt: "ACME price gate fired. Gate result:\n{{gateResult}}\nVerify thesis/news before recommending action.",
        },
      },
      cooldownMinutes: 120,
      activeHours: { start: 10, end: 15, timezone: "America/New_York" },
      priority: 2,
    },
    {
      name: "KTOS bounded reversal gate",
      triggerType: "periodic",
      condition: { guard: { rules: [{ type: "market_session", market: "XNAS", phase: "regular" }] } },
      actionType: "script_gate",
      actionConfig: {
        script: "market_quote_threshold",
        input: {
          ticker: "KTOS",
          groups: [{
            label: "confirmed reversal band",
            conditions: [
              { field: "price", op: "gte", value: 58 },
              { field: "price", op: "lte", value: 60 },
              { field: "volume", op: "gte", value: 5_000_000 },
            ],
          }],
        },
        onTrue: {
          provider: "claude",
          prompt: "KTOS bounded reversal gate fired. Gate result:\n{{gateResult}}\nCheck catalyst quality before recommending action.",
        },
      },
      cooldownMinutes: 120,
      activeHours: { start: 10, end: 15, timezone: "America/New_York" },
      priority: 2,
    },
  ],
};
