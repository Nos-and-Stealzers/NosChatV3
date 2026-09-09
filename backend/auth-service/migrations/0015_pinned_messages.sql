-- Pinned messages for guild text channels (Discord-style "Pinned
-- Messages" panel per channel). DMs intentionally don't get pins here,
-- matching Discord's own behavior (pins are a channel/server feature,
-- not a 1:1 DM feature).
--
-- Nullable pinned_at/pinned_by directly on guild_messages rather than a
-- separate join table: a message is pinned by at most one action at a
-- time (no multi-pin history to track), so a couple of nullable columns
-- is simpler than a table with its own lifecycle.

ALTER TABLE guild_messages
    ADD COLUMN pinned_at TIMESTAMPTZ,
    ADD COLUMN pinned_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Partial index: only rows that are actually pinned need to be found
-- fast (the "list pins for channel X" query), so indexing every row
-- (including the vast majority that are never pinned) would be wasted
-- space.
CREATE INDEX guild_messages_pinned_idx ON guild_messages (channel_id, pinned_at)
    WHERE pinned_at IS NOT NULL;
