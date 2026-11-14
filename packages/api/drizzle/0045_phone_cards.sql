-- Time-windowed cards for the iPhone widget.
CREATE TABLE `phone_cards` (
  `id` text PRIMARY KEY NOT NULL,
  `group_key` text NOT NULL,
  `board` text NOT NULL,
  `show_from` text NOT NULL,
  `show_until` text NOT NULL,
  `headline` text NOT NULL,
  `detail` text,
  `countdown_to` text,
  `alerts` text NOT NULL,
  `icon` text,
  `tone` text NOT NULL,
  `rows` text NOT NULL,
  `link` text,
  `source` text,
  `checked_at` text
);
--> statement-breakpoint
CREATE INDEX `phone_cards_group_key_idx` ON `phone_cards` (`group_key`);
