CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`content` text NOT NULL,
	`category` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
