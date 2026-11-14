CREATE TABLE `routing_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`original_routing` text,
	`user_message` text,
	`feedback_type` text NOT NULL,
	`correction` text,
	`created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
