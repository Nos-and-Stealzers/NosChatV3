-- Platform-level ban (distinct from a per-guild ban in guild_bans —
-- this blocks the account from using NosChat at all, any guild, any DM).
-- Nullable banned_at/banned_reason/banned_by rather than a separate table:
-- same reasoning as guild_messages.pinned_at in 0015 — a user is banned by
-- at most one action at a time, no history to track here.

ALTER TABLE users
    ADD COLUMN is_banned    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN banned_at    TIMESTAMPTZ,
    ADD COLUMN banned_reason TEXT,
    ADD COLUMN banned_by    UUID REFERENCES users(id) ON DELETE SET NULL;
