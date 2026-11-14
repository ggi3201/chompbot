-- Where a user message came from: 'telegram', 'discord', or null for the web chat.
ALTER TABLE `chat_messages` ADD `source` text;
