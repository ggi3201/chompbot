CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_slug_unique` ON `dashboards` (`slug`);
--> statement-breakpoint
CREATE TABLE `dashboard_widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`dashboard_id` text NOT NULL,
	`title` text NOT NULL,
	`blocks` text DEFAULT '[]' NOT NULL,
	`source_message_id` text,
	`grid_x` integer DEFAULT 0 NOT NULL,
	`grid_y` integer DEFAULT 0 NOT NULL,
	`grid_w` integer DEFAULT 1 NOT NULL,
	`grid_h` integer DEFAULT 1 NOT NULL,
	`refresher_id` text,
	`refresher_kind` text,
	`schema_json` text,
	`last_refreshed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON UPDATE no action ON DELETE cascade
);
