ALTER TABLE `dashboard_widgets` ADD `refresher_payload` text;
--> statement-breakpoint
ALTER TABLE `dashboard_widgets` ADD `classifying` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `dashboard_widgets` ADD `last_classify_error` text;
