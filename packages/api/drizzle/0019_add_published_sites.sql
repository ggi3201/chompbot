CREATE TABLE IF NOT EXISTS `published_sites` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`html_content` text NOT NULL,
	`status` text NOT NULL DEFAULT 'draft',
	`password` text,
	`url` text,
	`created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	`published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `published_sites_slug_unique` ON `published_sites` (`slug`);