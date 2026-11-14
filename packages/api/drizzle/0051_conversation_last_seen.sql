-- When the user last looked at the chat on any device, so unread marks follow them between web and phone.
ALTER TABLE `conversations` ADD `last_seen_at` text;
--> statement-breakpoint
-- Existing chats start read, so the deploy does not light up the whole list.
UPDATE `conversations` SET `last_seen_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
