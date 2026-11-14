-- Where the user has been, and triggers that delete themselves after firing.
CREATE TABLE `location_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source` text NOT NULL,
  `latitude` real NOT NULL,
  `longitude` real NOT NULL,
  `accuracy_meters` real NOT NULL,
  `place` text,
  `address` text,
  `captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `location_history_captured_at_idx` ON `location_history` (`captured_at`);
--> statement-breakpoint
ALTER TABLE `event_triggers` ADD `once` integer DEFAULT false NOT NULL;
