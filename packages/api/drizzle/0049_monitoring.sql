-- Monitoring: what Chomp watches, its checks and hourly rollups, host metrics, warnings and incidents.
-- Check, rollup and metric times are epoch milliseconds. Everything else is ISO text.
CREATE TABLE `monitor_targets` (
  `key` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `kind` text NOT NULL,
  `url` text,
  `host` text,
  `port` integer,
  `bind_address` text,
  `project` text,
  `exposure` text,
  `sources` text DEFAULT '[]' NOT NULL,
  `container` text,
  `image` text,
  `systemd_unit` text,
  `depends_on` text DEFAULT '[]' NOT NULL,
  `tracked` integer DEFAULT true NOT NULL,
  `hidden` integer DEFAULT false NOT NULL,
  `expected_status` integer,
  `push_token` text,
  `push_interval_sec` integer,
  `notes` text,
  `status` text DEFAULT 'unknown' NOT NULL,
  `status_since` text,
  `last_checked_at` integer,
  `last_push_at` integer,
  `last_push_ok` integer,
  `last_push_msg` text,
  `first_seen` text NOT NULL,
  `last_seen` text NOT NULL,
  `retired_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_targets_push_token_idx` ON `monitor_targets` (`push_token`);
--> statement-breakpoint
CREATE TABLE `monitor_checks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `target_key` text NOT NULL,
  `ts` integer NOT NULL,
  `vantage` text DEFAULT 'home' NOT NULL,
  `ok` integer NOT NULL,
  `status_code` integer,
  `latency_ms` integer,
  `error` text
);
--> statement-breakpoint
CREATE INDEX `monitor_checks_target_ts_idx` ON `monitor_checks` (`target_key`, `vantage`, `ts`);
--> statement-breakpoint
CREATE INDEX `monitor_checks_ts_idx` ON `monitor_checks` (`ts`);
--> statement-breakpoint
CREATE TABLE `monitor_rollups` (
  `target_key` text NOT NULL,
  `vantage` text DEFAULT 'home' NOT NULL,
  `hour` integer NOT NULL,
  `up` integer NOT NULL,
  `down` integer NOT NULL,
  `latency_avg` real,
  `latency_max` integer,
  PRIMARY KEY (`target_key`, `vantage`, `hour`)
);
--> statement-breakpoint
CREATE INDEX `monitor_rollups_hour_idx` ON `monitor_rollups` (`hour`);
--> statement-breakpoint
CREATE TABLE `host_metrics` (
  `host` text NOT NULL,
  `metric` text NOT NULL,
  `ts` integer NOT NULL,
  `value` real NOT NULL,
  PRIMARY KEY (`host`, `metric`, `ts`)
);
--> statement-breakpoint
CREATE INDEX `host_metrics_ts_idx` ON `host_metrics` (`ts`);
--> statement-breakpoint
CREATE TABLE `host_metric_rollups` (
  `host` text NOT NULL,
  `metric` text NOT NULL,
  `hour` integer NOT NULL,
  `avg` real NOT NULL,
  `max` real NOT NULL,
  PRIMARY KEY (`host`, `metric`, `hour`)
);
--> statement-breakpoint
CREATE TABLE `monitor_warnings` (
  `key` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `target_key` text,
  `text` text NOT NULL,
  `first_seen` text NOT NULL,
  `last_seen` text NOT NULL,
  `resolved_at` text,
  `notified_at` text,
  `muted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `monitor_warnings_target_idx` ON `monitor_warnings` (`target_key`);
--> statement-breakpoint
CREATE TABLE `incidents` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `cause_key` text NOT NULL,
  `state` text DEFAULT 'open' NOT NULL,
  `flapping` integer DEFAULT false NOT NULL,
  `started_at` text NOT NULL,
  `ended_at` text,
  `telegram_message_id` integer,
  `conversation_id` text
);
--> statement-breakpoint
CREATE INDEX `incidents_started_idx` ON `incidents` (`started_at`);
--> statement-breakpoint
CREATE TABLE `incident_targets` (
  `incident_id` text NOT NULL,
  `target_key` text NOT NULL,
  `down_at` text NOT NULL,
  `up_at` text,
  PRIMARY KEY (`incident_id`, `target_key`)
);
--> statement-breakpoint
CREATE INDEX `incident_targets_target_idx` ON `incident_targets` (`target_key`);
--> statement-breakpoint
CREATE TABLE `incident_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `incident_id` text NOT NULL,
  `ts` text NOT NULL,
  `kind` text NOT NULL,
  `text` text
);
--> statement-breakpoint
CREATE INDEX `incident_events_incident_idx` ON `incident_events` (`incident_id`, `ts`);
