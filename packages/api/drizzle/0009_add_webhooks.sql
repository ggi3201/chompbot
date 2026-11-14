CREATE TABLE IF NOT EXISTS `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`secret` text NOT NULL,
	`event_type` text NOT NULL DEFAULT 'webhook.received',
	`enabled` integer NOT NULL DEFAULT true,
	`last_received_at` text,
	`receive_count` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
