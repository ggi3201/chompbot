import { eq, sql } from "drizzle-orm";
import type { RunTarget } from "@chomp/shared";
import { providerOfModel, runTargetFrom, targetFromName, findSoulByName } from "../agents/run-target.js";
import { db } from "../db/index.js";
import { dashboardWidgets, eventTriggers, proactiveRules, settings } from "../db/schema.js";
import { backupBeforeMigration } from "../lib/backup.js";

type Config = Record<string, unknown>;
type ResolveAgent = (name: string | undefined, id: string | undefined) => RunTarget | undefined;

/**
 * Rewrites a saved config from an agent name to what that agent meant. What the
 * config already says wins over what the agent row said. Returns null when there
 * is nothing to move, or when the name resolves to nothing (left as it is, so
 * running it reports the missing agent).
 */
export function moveAgentToTarget(config: Config, nameKey: string, resolve: ResolveAgent): Config | null {
  const name = typeof config[nameKey] === "string" ? (config[nameKey] as string) : undefined;
  const id = typeof config.agentId === "string" ? config.agentId : undefined;
  if (!name && !id) return null;
  const agent = resolve(name, id);
  if (!agent) return null;

  const { [nameKey]: _name, agentId: _id, ...rest } = config;
  const own = runTargetFrom(rest);
  const provider = own.provider ?? (own.model ? providerOfModel(own.model) : agent.provider);
  const sameProvider = provider === agent.provider;
  const model = own.model ?? (sameProvider ? agent.model : undefined);
  const effort = own.effort ?? (sameProvider ? agent.effort : undefined);
  const soulId = own.soulId ?? agent.soulId;
  return {
    ...rest,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(soulId ? { soulId } : {}),
  };
}

interface AgentRow {
  id: string;
  name: string;
  type: string;
  config: string;
}

function agentResolver(): ResolveAgent {
  const hasTable = db.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'`).length > 0;
  const rows = hasTable ? db.all<AgentRow>(sql`SELECT id, name, type, config FROM agents`) : [];

  return (name, id) => {
    const wanted = name?.toLowerCase();
    const row = rows.find((r) => r.id === id) ?? rows.find((r) => r.name.toLowerCase() === wanted);
    if (row) {
      const config = JSON.parse(row.config || "{}") as Config;
      return { ...runTargetFrom(config), provider: row.type === "codex-sdk" ? "codex" : "claude" };
    }
    if (!name) return undefined;
    // Deleted soul clones, like AlfredCodex: the soul on Codex.
    const clone = /^(.+)Codex$/.exec(name);
    const cloneSoul = clone ? findSoulByName(clone[1]) : undefined;
    return cloneSoul ? { provider: "codex", soulId: cloneSoul.id } : targetFromName(name);
  };
}

function parse(json: string | null): Config {
  try {
    const value = JSON.parse(json || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Config) : {};
  } catch {
    return {};
  }
}

/** A rule's agent sits on the config itself, a script gate's also under onTrue. */
function moveRuleConfig(config: Config, resolve: ResolveAgent): Config | null {
  const top = moveAgentToTarget(config, "agent", resolve);
  const base = top ?? config;
  const onTrue = base.onTrue && typeof base.onTrue === "object" ? moveAgentToTarget(base.onTrue as Config, "agent", resolve) : null;
  if (!top && !onTrue) return null;
  return onTrue ? { ...base, onTrue } : base;
}

const LEGACY_DEFAULTS = [
  { legacyKey: "default_agent", key: "run_target" },
  { legacyKey: "discord_default_agent", key: "run_target_discord" },
  { legacyKey: "telegram_default_agent", key: "run_target_telegram" },
];

/**
 * One-time move off the agents table: saved rules, triggers, widgets and channel
 * defaults get a target in place of an agent name. Safe to run on every start:
 * once nothing names an agent there is nothing to do, and no backup is taken.
 */
export function migrateAgentNamesToTargets(): void {
  const resolve = agentResolver();

  const rules = db.select().from(proactiveRules).all().flatMap((rule) => {
    const moved = moveRuleConfig(parse(rule.actionConfig), resolve);
    return moved ? [{ id: rule.id, moved }] : [];
  });
  const triggers = db.select().from(eventTriggers).all().flatMap((trigger) => {
    const moved = moveAgentToTarget(parse(trigger.action), "agentName", resolve);
    return moved ? [{ id: trigger.id, moved }] : [];
  });
  const widgets = db.select().from(dashboardWidgets).all().flatMap((widget) => {
    const moved = moveAgentToTarget(parse(widget.refresherPayload), "agentName", resolve);
    return moved ? [{ id: widget.id, moved }] : [];
  });
  const defaults = LEGACY_DEFAULTS.flatMap(({ legacyKey, key }) => {
    const legacy = db.select().from(settings).where(eq(settings.key, legacyKey)).get();
    return legacy ? [{ legacyKey, key, name: legacy.value.trim() }] : [];
  });

  if (rules.length + triggers.length + widgets.length + defaults.length === 0) return;

  backupBeforeMigration("run-targets");

  db.transaction((tx) => {
    for (const { id, moved } of rules) {
      tx.update(proactiveRules).set({ actionConfig: JSON.stringify(moved) }).where(eq(proactiveRules.id, id)).run();
    }
    for (const { id, moved } of triggers) {
      tx.update(eventTriggers).set({ action: JSON.stringify(moved) }).where(eq(eventTriggers.id, id)).run();
    }
    for (const { id, moved } of widgets) {
      tx.update(dashboardWidgets).set({ refresherPayload: JSON.stringify(moved) }).where(eq(dashboardWidgets.id, id)).run();
    }
    for (const { legacyKey, key, name } of defaults) {
      const target = name ? resolve(name, undefined) : undefined;
      const saved = tx.select().from(settings).where(eq(settings.key, key)).get();
      if (target && !saved) {
        // The overall default's agent is the soul marked as default, so it only keeps the engine.
        const { soulId, ...engine } = target;
        const value = JSON.stringify(key === "run_target" ? engine : target);
        tx.insert(settings).values({ key, value }).run();
      }
      tx.delete(settings).where(eq(settings.key, legacyKey)).run();
    }
  });
  console.log(`[migrate] Moved to run targets: ${rules.length} rules, ${triggers.length} triggers, ${widgets.length} widgets, ${defaults.length} defaults`);
}
