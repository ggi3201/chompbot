ALTER TABLE `dashboards` ADD `auto_refresh_enabled` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `dashboard_widgets` ADD `refresh_interval_minutes` integer;
