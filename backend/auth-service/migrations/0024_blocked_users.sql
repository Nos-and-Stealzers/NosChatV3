-- User blocking (Discord-style): blocking someone prevents them from
-- sending you friend requests or DMs, and removes any existing
-- friendship between you. Directional — A blocking B doesn't stop B's
-- other friendships, only A<->B interaction.
CREATE TABLE blocked_users (
    blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX blocked_users_blocked_idx ON blocked_users (blocked_id);
