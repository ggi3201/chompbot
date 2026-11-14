ALTER TABLE `conversations` ADD COLUMN `tags` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `conversations` ADD COLUMN `pinned` integer NOT NULL DEFAULT 0;
