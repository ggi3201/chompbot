ALTER TABLE conversations ADD COLUMN soul_id TEXT;
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN native_ref TEXT;
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN cwd TEXT;
