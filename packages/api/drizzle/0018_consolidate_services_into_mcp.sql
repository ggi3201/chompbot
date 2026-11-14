ALTER TABLE `mcp_servers` ADD `credentials` text NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `health_check_url` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `health_check_interval` integer NOT NULL DEFAULT 300;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `health_status` text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `consecutive_failures` integer NOT NULL DEFAULT 0;
