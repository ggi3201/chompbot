ALTER TABLE `connected_services` ADD `health_check_url` text;
--> statement-breakpoint
ALTER TABLE `connected_services` ADD `health_check_interval` integer NOT NULL DEFAULT 300;
--> statement-breakpoint
ALTER TABLE `connected_services` ADD `last_health_check` text;
--> statement-breakpoint
ALTER TABLE `connected_services` ADD `health_status` text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `connected_services` ADD `consecutive_failures` integer NOT NULL DEFAULT 0;
