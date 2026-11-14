import { index, primaryKey, real, sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Which chat a sent Telegram message belongs to. No FK: deleting a chat must not
// be blocked by old links, and a link to a deleted chat is simply ignored.
export const telegramMessageLinks = sqliteTable("telegram_message_links", {
  telegramMsgId: integer("telegram_msg_id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
});

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

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  content: text("content").notNull().default(""),
  source: text("source").notNull().default("user"),  // "user" | "marketplace"
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
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

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull().default("0.0.0"),
  description: text("description").notNull().default(""),
  source: text("source").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  config: text("config").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title"),
  ccSessionId: text("cc_session_id"),
  codexSessionId: text("codex_session_id"),
  copilotSessionId: text("copilot_session_id"),
  pinnedAgent: text("pinned_agent"),
  /** The soul the conversation's native sessions were started with ("" = none). A different soul starts fresh sessions. */
  soulId: text("soul_id"),
  /** A turn that was running when the API shut down, as JSON: the startup resumes it once. */
  resumeTurn: text("resume_turn"),
  /** JSON ContextUsage from the last turn, for the context meter. */
  contextUsage: text("context_usage"),
  /** The chat this one was forked or handed off from, and which of the two. */
  parentId: text("parent_id"),
  parentKind: text("parent_kind"),
  /** The repo the chat's agents run in; null runs them in the default directory. Set with the first message. */
  projectPath: text("project_path"),
  /** The chat's own git worktree of projectPath, created on its first turn; its agents run there. */
  worktreePath: text("worktree_path"),
  /** False runs the chat's agents in projectPath itself, unticked in the project menu. */
  useWorktree: integer("use_worktree", { mode: "boolean" }).notNull().default(true),
  tags: text("tags").notNull().default("[]"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  /** When the user last had the chat on screen, on any device; a reply after it is unread. */
  lastSeenAt: text("last_seen_at"),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  routing: text("routing"),
  agentUsed: text("agent_used"),
  turnId: text("turn_id"),
  /** Where a user message came from: "telegram", "discord", or null for the web chat. */
  source: text("source"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

/** Structured agent output (tool calls, commands, diffs, reasoning) — see `ChatItem` in @chomp/shared. */
export const chatItems = sqliteTable("chat_items", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  parentId: text("parent_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  agentId: text("agent_id"),
  content: text("content").notNull(),
  category: text("category").notNull(),
  embedding: text("embedding"),
  embeddingModel: text("embedding_model"),
  source: text("source").notNull().default("user"),
  sourceConversationId: text("source_conversation_id"),
  confidence: integer("confidence").notNull().default(100),
  // Claims: an auto memory carries the user's own words it came from, and a newer
  // one can replace an older one. Superseded rows are hidden, never deleted.
  status: text("status").notNull().default("active"), // active | superseded | retired (an agent deleted it)
  supersedesId: text("supersedes_id"),
  evidenceQuote: text("evidence_quote"),
  evidenceMessageId: text("evidence_message_id"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const eventTriggers = sqliteTable("event_triggers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  eventType: text("event_type").notNull(),
  condition: text("condition").notNull().default("{}"),
  action: text("action").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(0),
  once: integer("once", { mode: "boolean" }).notNull().default(false),
  lastTriggeredAt: text("last_triggered_at"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const proactiveRules = sqliteTable("proactive_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  condition: text("condition").notNull().default("{}"),
  actionType: text("action_type").notNull(),
  actionConfig: text("action_config").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
  activeHours: text("active_hours").notNull().default("{}"),
  priority: integer("priority").notNull().default(0),
  notificationChannels: text("notification_channels").notNull().default('["telegram"]'),
  runAt: text("run_at"),
  lastTriggeredAt: text("last_triggered_at"),
  triggerCount: integer("trigger_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const proactiveRuleRuns = sqliteTable("proactive_rule_runs", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => proactiveRules.id, { onDelete: "cascade" }),
  triggeredAt: text("triggered_at").notNull(),
  triggerType: text("trigger_type").notNull(), // "event" | "periodic" | "manual"
  outcome: text("outcome").notNull(), // "fired" | "skipped_cooldown" | "skipped_active_hours" | "skipped_guard" | "skipped_rate_limit" | "error"
  reason: text("reason"),
  outputPreview: text("output_preview"), // first 500 chars of agent response
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
}, (table) => [index("proactive_rule_runs_triggered_at_idx").on(table.triggeredAt)]);

export const routingFeedback = sqliteTable("routing_feedback", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  originalRouting: text("original_routing"),
  userMessage: text("user_message"),
  feedbackType: text("feedback_type").notNull(),
  correction: text("correction"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  secret: text("secret").notNull(),
  eventType: text("event_type").notNull().default("webhook.received"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastReceivedAt: text("last_received_at"),
  receiveCount: integer("receive_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const agentSessions = sqliteTable("agent_sessions", {
  sessionId: text("session_id").primaryKey(),
  ccSessionId: text("cc_session_id"),
  agentName: text("agent_name").notNull(),
  agentType: text("agent_type").notNull(),
  conversationId: text("conversation_id"),
  pid: integer("pid"),
  prompt: text("prompt"),
  userPrompt: text("user_prompt"),
  label: text("label"),
  model: text("model"),
  status: text("status").notNull(),
  outputBytes: integer("output_bytes").notNull().default(0),
  outputChunks: integer("output_chunks").notNull().default(0),
  durationMs: integer("duration_ms"),
  error: text("error"),
  logPath: text("log_path"),
  /** Where a fork of this turn starts: Claude's last assistant message uuid, or Codex's turn id. */
  nativeRef: text("native_ref"),
  cwd: text("cwd"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
});

export const publishedSites = sqliteTable("published_sites", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  htmlContent: text("html_content").notNull(),
  status: text("status").notNull().default("draft"), // draft | published | archived
  password: text("password"), // optional, plain text stored for auth gate
  url: text("url"),
  source: text("source").notNull().default("db"), // db | git
  repoUrl: text("repo_url"),
  repoBranch: text("repo_branch").notNull().default("main"),
  lastCommitSha: text("last_commit_sha"),
  sourceUpdatedAt: text("source_updated_at"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  publishedAt: text("published_at"),
});

export const souls = sqliteTable("souls", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  content: text("content").notNull().default(""),
  imageUrl: text("image_url"),
  color: text("color").notNull().default("violet"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
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

// Saved-widget dashboards. Each dashboard is a named grid that holds widgets.
export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  // Master killswitch for auto-refresh on this dashboard. When false, no widget
  // here auto-refreshes regardless of its individual interval.
  autoRefreshEnabled: integer("auto_refresh_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// A widget is a saved canvas response pinned to a dashboard.
export const dashboardWidgets = sqliteTable("dashboard_widgets", {
  id: text("id").primaryKey(),
  dashboardId: text("dashboard_id")
    .notNull()
    .references(() => dashboards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  // JSON-encoded array of CanvasBlock objects extracted from the source message.
  blocks: text("blocks").notNull().default("[]"),
  sourceMessageId: text("source_message_id"),
  // Grid placement.
  gridX: integer("grid_x").notNull().default(0),
  gridY: integer("grid_y").notNull().default(0),
  gridW: integer("grid_w").notNull().default(1),
  gridH: integer("grid_h").notNull().default(1),
  // Refresher metadata. refresherId is reserved for a future shared
  // refresher table; for now refreshers are 1:1 with widgets and stored inline.
  refresherId: text("refresher_id"),
  refresherKind: text("refresher_kind"), // 'template' | 'agent' | null = frozen
  refresherPayload: text("refresher_payload"), // JSON: shape depends on kind
  schemaJson: text("schema_json"), // JSON array of {type, requiredKeys[]} block descriptors
  lastRefreshedAt: text("last_refreshed_at"),
  // null = manual refresh only. Auto-refresh fires only when this is set AND
  // the parent dashboard's auto_refresh_enabled is true.
  refreshIntervalMinutes: integer("refresh_interval_minutes"),
  classifying: integer("classifying", { mode: "boolean" }).notNull().default(false),
  lastClassifyError: text("last_classify_error"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * APNs device token per paired iOS device. The bridge uses this to send a
 * silent push (`{aps:{content-available:1}}`) when the device is offline,
 * which wakes the ChompCompanion app long enough to reconnect its WebSocket.
 */
export const devicePushTokens = sqliteTable("device_push_tokens", {
  deviceId: text("device_id").primaryKey(),
  apnsToken: text("apns_token").notNull(),
  platform: text("platform").notNull().default("ios"),
  // 'production' or 'development' — picks the APNs hostname. TestFlight builds
  // are always 'production'; only Xcode dev installs use 'development'.
  environment: text("environment").notNull().default("production"),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * Time-windowed cards for the iPhone widget. Publishing replaces a whole group,
 * because one change, like a delayed train, moves all the cards of a trip.
 * Every time is a UTC ISO string, so they compare as text.
 */
export const phoneCards = sqliteTable("phone_cards", {
  id: text("id").primaryKey(),
  groupKey: text("group_key").notNull(),
  board: text("board").notNull(),
  showFrom: text("show_from").notNull(),
  showUntil: text("show_until").notNull(),
  headline: text("headline").notNull(),
  detail: text("detail"),
  countdownTo: text("countdown_to"),
  alerts: text("alerts", { mode: "json" }).$type<{ at: string; text: string }[]>().notNull(),
  icon: text("icon"), // SF Symbol name
  tone: text("tone", { enum: ["normal", "urgent"] }).notNull(),
  rows: text("rows", { mode: "json" }).$type<{ label: string; value: string }[]>().notNull(),
  link: text("link"),
  source: text("source"),
  checkedAt: text("checked_at"),
}, (table) => [index("phone_cards_group_key_idx").on(table.groupKey)]);

/** Where the user has been. `place` is the named place they were in at that moment, null for none. */
export const locationHistory = sqliteTable("location_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  accuracyMeters: real("accuracy_meters").notNull(),
  place: text("place"),
  address: text("address"),
  capturedAt: text("captured_at").notNull(),
}, (table) => [index("location_history_captured_at_idx").on(table.capturedAt)]);

/** A post the user publishes by hand. Each platform has its own caption and crop of the media. */
export const socialPosts = sqliteTable("social_posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  dueAt: text("due_at").notNull(), // UTC ISO, compares as text
  platforms: text("platforms", { mode: "json" }).$type<{
    platform: "instagram" | "tiktok" | "pinterest";
    caption: string;
    media: { url: string; type: "image" | "video"; altText?: string }[];
    postedAt: string | null;
  }[]>().notNull(),
  notifiedAt: text("notified_at"),
  nudgedAt: text("nudged_at"),
  createdAt: text("created_at").notNull(),
});

/**
 * De-duplication ledger for the `company_news_scan` script gate. One row per
 * (ticker, source, externalId) the gate has already surfaced, so the same SEC
 * 8-K filing or news article never re-fires the agent on a later poll. Lives in
 * the DB (not a JSON file) so it survives the constant prod restarts that
 * auto-deploy causes. Rows older than the gate's retention window are pruned on
 * each run to keep the table bounded.
 */
export const newsSeen = sqliteTable("news_seen", {
  // `${source}:${ticker}:${externalId}` — e.g. "edgar:ACME:0001234567-25-000123"
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  source: text("source").notNull(), // "edgar" | "finnhub"
  externalId: text("external_id").notNull(),
  headline: text("headline"),
  url: text("url"),
  publishedAt: text("published_at"), // ISO string of the event time, when known
  seenAt: text("seen_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// ── Monitoring ──────────────────────────────────────────────────────────
// Check, rollup and metric timestamps are epoch milliseconds: they are written by the thousand a day
// and compared as numbers. Targets, warnings and incidents are few and use ISO text like the rest of the schema.

/** What Docker says about the container behind a target. */
export interface ContainerInfo {
  state: string;
  health: string | null;
  restarts: number;
  oomKilled: boolean;
  /** The container's address on a Docker network. The host reaches it there when the name does not resolve. */
  ip: string | null;
}

/** Anything Chomp watches: a URL, a port, a host, or a job that pushes. Retired targets keep their history. */
export const monitorTargets = sqliteTable("monitor_targets", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  kind: text("kind", { enum: ["http", "tcp", "ping", "push", "host", "container"] }).notNull(),
  url: text("url"),
  host: text("host"),
  port: integer("port"),
  bindAddress: text("bind_address"),
  project: text("project"),
  exposure: text("exposure"),
  sources: text("sources", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  container: text("container"),
  image: text("image"),
  systemdUnit: text("systemd_unit"),
  dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  tracked: integer("tracked", { mode: "boolean" }).notNull().default(true),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  expectedStatus: integer("expected_status"),
  pushToken: text("push_token"),
  pushIntervalSec: integer("push_interval_sec"),
  notes: text("notes"),
  // Fields the person edited. Discovery fills in the others on every run and leaves these alone.
  userFields: text("user_fields", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  // The state of the container behind the target, as of the last discovery run.
  containerInfo: text("container_info", { mode: "json" }).$type<ContainerInfo>(),
  // Discovery runs in a row that did not see this target. Three retire it.
  missedRuns: integer("missed_runs").notNull().default(0),
  // Derived from the checks, kept here so the scheduler and the page do not rescan history.
  status: text("status", { enum: ["unknown", "up", "down"] }).notNull().default("unknown"),
  statusSince: text("status_since"),
  lastCheckedAt: integer("last_checked_at"),
  lastPushAt: integer("last_push_at"),
  lastPushOk: integer("last_push_ok", { mode: "boolean" }),
  lastPushMsg: text("last_push_msg"),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  retiredAt: text("retired_at"),
}, (table) => [uniqueIndex("monitor_targets_push_token_idx").on(table.pushToken)]);

/** One raw check. Kept 48 hours, then only the hourly rollup remains. */
export const monitorChecks = sqliteTable("monitor_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetKey: text("target_key").notNull(),
  ts: integer("ts").notNull(),
  vantage: text("vantage", { enum: ["home", "outside"] }).notNull().default("home"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  statusCode: integer("status_code"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
}, (table) => [
  index("monitor_checks_target_ts_idx").on(table.targetKey, table.vantage, table.ts),
  index("monitor_checks_ts_idx").on(table.ts),
]);

/** Checks of one target in one hour. `hour` is the epoch ms of the hour start. Kept 400 days. */
export const monitorRollups = sqliteTable("monitor_rollups", {
  targetKey: text("target_key").notNull(),
  vantage: text("vantage", { enum: ["home", "outside"] }).notNull().default("home"),
  hour: integer("hour").notNull(),
  up: integer("up").notNull(),
  down: integer("down").notNull(),
  latencyAvg: real("latency_avg"),
  latencyMax: integer("latency_max"),
}, (table) => [primaryKey({ columns: [table.targetKey, table.vantage, table.hour] }), index("monitor_rollups_hour_idx").on(table.hour)]);

/** One reading of a host metric (cpu, memory, disk, load). Kept 7 days. */
export const hostMetrics = sqliteTable("host_metrics", {
  host: text("host").notNull(),
  metric: text("metric").notNull(),
  ts: integer("ts").notNull(),
  value: real("value").notNull(),
}, (table) => [primaryKey({ columns: [table.host, table.metric, table.ts] }), index("host_metrics_ts_idx").on(table.ts)]);

export const hostMetricRollups = sqliteTable("host_metric_rollups", {
  host: text("host").notNull(),
  metric: text("metric").notNull(),
  hour: integer("hour").notNull(),
  avg: real("avg").notNull(),
  max: real("max").notNull(),
}, (table) => [primaryKey({ columns: [table.host, table.metric, table.hour] })]);

/** A condition worth a look that is not an outage (open database port, expiring certificate, ...). */
export const monitorWarnings = sqliteTable("monitor_warnings", {
  key: text("key").primaryKey(),
  kind: text("kind").notNull(),
  targetKey: text("target_key"),
  text: text("text").notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  resolvedAt: text("resolved_at"),
  notifiedAt: text("notified_at"),
  muted: integer("muted", { mode: "boolean" }).notNull().default(false),
}, (table) => [index("monitor_warnings_target_idx").on(table.targetKey)]);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  causeKey: text("cause_key").notNull(),
  state: text("state", { enum: ["open", "resolved"] }).notNull().default("open"),
  flapping: integer("flapping", { mode: "boolean" }).notNull().default(false),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  telegramMessageId: integer("telegram_message_id"),
  conversationId: text("conversation_id"),
}, (table) => [index("incidents_started_idx").on(table.startedAt)]);

export const incidentTargets = sqliteTable("incident_targets", {
  incidentId: text("incident_id").notNull(),
  targetKey: text("target_key").notNull(),
  downAt: text("down_at").notNull(),
  upAt: text("up_at"),
}, (table) => [primaryKey({ columns: [table.incidentId, table.targetKey] }), index("incident_targets_target_idx").on(table.targetKey)]);

export const incidentEvents = sqliteTable("incident_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  incidentId: text("incident_id").notNull(),
  ts: text("ts").notNull(),
  kind: text("kind").notNull(),
  text: text("text"),
}, (table) => [index("incident_events_incident_idx").on(table.incidentId, table.ts)]);
