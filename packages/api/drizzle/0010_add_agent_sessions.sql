CREATE TABLE `agent_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`cc_session_id` text,
	`agent_name` text NOT NULL,
	`agent_type` text NOT NULL,
	`conversation_id` text,
	`pid` integer,
	`prompt` text,
	`model` text,
	`status` text NOT NULL,
	`output_bytes` integer NOT NULL DEFAULT 0,
	`output_chunks` integer NOT NULL DEFAULT 0,
	`duration_ms` integer,
	`error` text,
	`started_at` text NOT NULL,
	`ended_at` text
);
