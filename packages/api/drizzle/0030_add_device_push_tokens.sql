CREATE TABLE IF NOT EXISTS `device_push_tokens` (
	`device_id` text PRIMARY KEY NOT NULL,
	`apns_token` text NOT NULL,
	`platform` text DEFAULT 'ios' NOT NULL,
	`environment` text DEFAULT 'production' NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_device_push_tokens_apns_token` ON `device_push_tokens` (`apns_token`);
