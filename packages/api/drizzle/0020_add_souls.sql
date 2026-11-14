CREATE TABLE IF NOT EXISTS `souls` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`content` text NOT NULL DEFAULT '',
	`image_url` text,
	`color` text NOT NULL DEFAULT 'violet',
	`is_default` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
