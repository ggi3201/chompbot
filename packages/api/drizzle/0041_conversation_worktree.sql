ALTER TABLE conversations ADD COLUMN worktree_path TEXT;
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 1;
