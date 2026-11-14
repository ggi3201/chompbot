CREATE TABLE `event_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`event_type` text NOT NULL,
	`condition` text NOT NULL DEFAULT '{}',
	`action` text NOT NULL DEFAULT '{}',
	`enabled` integer NOT NULL DEFAULT true,
	`cooldown_seconds` integer NOT NULL DEFAULT 0,
	`last_triggered_at` text,
	`created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
