-- Guild bans — Discord-style: a banned user's membership row is removed
-- (so they immediately lose access) AND a ban record is kept so they
-- can't just rejoin via an invite link. Separate from guild_members
-- since a ban can exist for someone who was never actually a member
-- (banning by user id without them having joined first, matching
-- Discord's "ban by ID" capability).

CREATE TABLE guild_bans (
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);
