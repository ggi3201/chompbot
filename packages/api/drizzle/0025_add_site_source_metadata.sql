ALTER TABLE `published_sites` ADD `source` text NOT NULL DEFAULT 'db';
--> statement-breakpoint
ALTER TABLE `published_sites` ADD `repo_url` text;
--> statement-breakpoint
ALTER TABLE `published_sites` ADD `repo_branch` text NOT NULL DEFAULT 'main';
--> statement-breakpoint
ALTER TABLE `published_sites` ADD `last_commit_sha` text;
--> statement-breakpoint
ALTER TABLE `published_sites` ADD `source_updated_at` text;
