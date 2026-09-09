-- Channel slow mode (rate limit) + NSFW flag — real per-channel settings,
-- Discord-style. slow_mode_seconds = 0 means disabled; enforcement lives
-- server-side in send_channel_message (guilds.rs), not just a UI hint.
ALTER TABLE guild_channels
    ADD COLUMN slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN is_nsfw BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE guild_channels
    ADD CONSTRAINT guild_channels_slow_mode_range CHECK (slow_mode_seconds BETWEEN 0 AND 21600);
