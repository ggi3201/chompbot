-- Create FTS5 virtual table for full-text search on chat messages
CREATE VIRTUAL TABLE IF NOT EXISTS `chat_messages_fts` USING fts5(
  `message_id` UNINDEXED,
  `conversation_id` UNINDEXED,
  `content`,
  tokenize = 'porter ascii'
);
--> statement-breakpoint
-- Populate FTS index from existing messages
INSERT INTO `chat_messages_fts` (rowid, `message_id`, `conversation_id`, `content`)
SELECT rowid, `id`, `conversation_id`, `content` FROM `chat_messages`;
--> statement-breakpoint
-- Trigger: after insert, add to FTS index
CREATE TRIGGER IF NOT EXISTS `chat_messages_fts_ai`
AFTER INSERT ON `chat_messages`
BEGIN
  INSERT INTO `chat_messages_fts` (rowid, `message_id`, `conversation_id`, `content`)
  VALUES (NEW.rowid, NEW.`id`, NEW.`conversation_id`, NEW.`content`);
END;
--> statement-breakpoint
-- Trigger: after delete, remove from FTS index
CREATE TRIGGER IF NOT EXISTS `chat_messages_fts_ad`
AFTER DELETE ON `chat_messages`
BEGIN
  INSERT INTO `chat_messages_fts` (`chat_messages_fts`, rowid, `message_id`, `conversation_id`, `content`)
  VALUES ('delete', OLD.rowid, OLD.`id`, OLD.`conversation_id`, OLD.`content`);
END;
--> statement-breakpoint
-- Trigger: after update, replace in FTS index
CREATE TRIGGER IF NOT EXISTS `chat_messages_fts_au`
AFTER UPDATE ON `chat_messages`
BEGIN
  INSERT INTO `chat_messages_fts` (`chat_messages_fts`, rowid, `message_id`, `conversation_id`, `content`)
  VALUES ('delete', OLD.rowid, OLD.`id`, OLD.`conversation_id`, OLD.`content`);
  INSERT INTO `chat_messages_fts` (rowid, `message_id`, `conversation_id`, `content`)
  VALUES (NEW.rowid, NEW.`id`, NEW.`conversation_id`, NEW.`content`);
END;
