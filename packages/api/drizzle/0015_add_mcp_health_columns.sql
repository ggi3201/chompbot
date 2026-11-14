ALTER TABLE `mcp_servers` ADD `last_health_check` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `is_reachable` integer;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `latency_ms` integer;
