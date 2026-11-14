CREATE TABLE IF NOT EXISTS `news_seen` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`headline` text,
	`url` text,
	`published_at` text,
	`seen_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_news_seen_ticker` ON `news_seen` (`ticker`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_news_seen_seen_at` ON `news_seen` (`seen_at`);
