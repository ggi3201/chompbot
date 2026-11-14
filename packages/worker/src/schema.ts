// Mirror of the API schema tables the worker needs access to.
// The worker shares the same SQLite database file.
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  naturalLanguage: text("natural_language").notNull(),
  cronExpression: text("cron_expression").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRun: text("last_run"),
  lastResult: text("last_result"),
  agentOverride: text("agent_override"),
  context: text("context").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const souls = sqliteTable("souls", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  config: text("config").notNull().default("{}"),
  credentials: text("credentials").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  healthCheckUrl: text("health_check_url"),
  healthCheckInterval: integer("health_check_interval").notNull().default(300),
  lastHealthCheck: text("last_health_check"),
  isReachable: integer("is_reachable", { mode: "boolean" }),
  latencyMs: integer("latency_ms"),
  healthStatus: text("health_status").notNull().default("unknown"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const activityLog = sqliteTable("activity_log", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  summary: text("summary").notNull(),
  details: text("details"),
  scheduleId: text("schedule_id"),
  agentUsed: text("agent_used"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// Dashboards / widgets — the worker only needs the columns required to find
// auto-refresh-due widgets. Full schema lives in packages/api/src/db/schema.ts.
export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  autoRefreshEnabled: integer("auto_refresh_enabled", { mode: "boolean" }).notNull().default(false),
});

export const dashboardWidgets = sqliteTable("dashboard_widgets", {
  id: text("id").primaryKey(),
  dashboardId: text("dashboard_id").notNull(),
  refresherKind: text("refresher_kind"),
  refreshIntervalMinutes: integer("refresh_interval_minutes"),
  lastRefreshedAt: text("last_refreshed_at"),
});
