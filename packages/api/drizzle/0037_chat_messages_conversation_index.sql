CREATE INDEX IF NOT EXISTS chat_messages_conversation_created ON chat_messages (conversation_id, created_at);
