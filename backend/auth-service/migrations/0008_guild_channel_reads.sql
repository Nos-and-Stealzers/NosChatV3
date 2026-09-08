-- Per-user, per-channel read tracking for guild text channels — mirrors
-- dm_participants.last_read_message_id so guild channels get the same
-- "unread" ping-dot capability DMs already have.

CREATE TABLE guild_channel_reads (
    channel_id              UUID NOT NULL REFERENCES guild_channels(id) ON DELETE CASCADE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id    UUID,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX guild_channel_reads_user_idx ON guild_channel_reads (user_id);
