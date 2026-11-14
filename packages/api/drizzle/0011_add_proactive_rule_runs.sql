CREATE TABLE `proactive_rule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`triggered_at` text NOT NULL,
	`trigger_type` text NOT NULL,
	`outcome` text NOT NULL,
	`output_preview` text,
	`duration_ms` integer,
	`error_message` text,
	FOREIGN KEY (`rule_id`) REFERENCES `proactive_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
