CREATE TABLE `proactive_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger_type` text NOT NULL,
	`condition` text NOT NULL DEFAULT '{}',
	`action_type` text NOT NULL,
	`action_config` text NOT NULL DEFAULT '{}',
	`enabled` integer NOT NULL DEFAULT true,
	`cooldown_minutes` integer NOT NULL DEFAULT 60,
	`active_hours` text NOT NULL DEFAULT '{}',
	`priority` integer NOT NULL DEFAULT 0,
	`last_triggered_at` text,
	`trigger_count` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
