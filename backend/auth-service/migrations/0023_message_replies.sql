-- Reply-to-message (Discord-style quoted reply) for both DM messages and
-- guild channel messages. Nullable self-referential FK, ON DELETE SET
-- NULL so deleting the original message doesn't cascade-delete every
-- reply to it — the reply just loses its quote context and renders as a
-- normal message (matches Discord's "Original message was deleted"
-- behavior conceptually, though we simply drop the reference rather than
-- keeping a tombstone).
ALTER TABLE messages ADD COLUMN reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE guild_messages ADD COLUMN reply_to_message_id UUID REFERENCES guild_messages(id) ON DELETE SET NULL;
