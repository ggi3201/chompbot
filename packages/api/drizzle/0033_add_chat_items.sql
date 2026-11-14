CREATE TABLE chat_items (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX chat_items_conversation_seq ON chat_items (conversation_id, seq);
--> statement-breakpoint
ALTER TABLE chat_messages ADD COLUMN turn_id TEXT;
