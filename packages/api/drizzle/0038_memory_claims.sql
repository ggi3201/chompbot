ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN supersedes_id TEXT;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN evidence_quote TEXT;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN evidence_message_id TEXT;
