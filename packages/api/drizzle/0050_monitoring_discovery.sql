-- Discovery: which fields a person edited, the state of a target's container, and how many runs missed it.
ALTER TABLE `monitor_targets` ADD `user_fields` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `monitor_targets` ADD `container_info` text;
--> statement-breakpoint
ALTER TABLE `monitor_targets` ADD `missed_runs` integer DEFAULT 0 NOT NULL;
