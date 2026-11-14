ALTER TABLE `memories` ADD `embedding` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD `embedding_model` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD `source` text NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE `memories` ADD `source_conversation_id` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD `confidence` integer NOT NULL DEFAULT 100;
