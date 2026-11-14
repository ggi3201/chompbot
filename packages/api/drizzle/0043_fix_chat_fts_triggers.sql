-- FTS5's 'delete' command only works on external-content tables, and this one stores its own content, so these failed with "SQL logic error".
DROP TRIGGER IF EXISTS `chat_messages_fts_ad`;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_ad`
AFTER DELETE ON `chat_messages`
BEGIN
  DELETE FROM `chat_messages_fts` WHERE rowid = OLD.rowid;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `chat_messages_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_au`
AFTER UPDATE ON `chat_messages`
BEGIN
  DELETE FROM `chat_messages_fts` WHERE rowid = OLD.rowid;
  INSERT INTO `chat_messages_fts` (rowid, `message_id`, `conversation_id`, `content`)
  VALUES (NEW.rowid, NEW.`id`, NEW.`conversation_id`, NEW.`content`);
END;
