-- Friends, DMs, messages, and per-user sound preferences — the first real
-- feature beyond the auth proof-of-concept. See master spec Sections 9.2
-- (Friend System) and 9.3 (Direct Messaging).
--
-- Realtime fan-out (WebSocket) is handled in-process (src/ws.rs), not via
-- Redis pub/sub yet — the spec calls for Redis pub/sub as the long-term
-- fan-out backbone for horizontal scaling (Section 8.1), but that's only
-- needed once this runs as more than one instance. Revisit when scaling
-- past a single backend process.

CREATE TABLE friendships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'blocked')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT friendships_no_self CHECK (requester_id <> addressee_id)
);

-- Undirected uniqueness: at most one relationship row per unordered pair.
-- Postgres doesn't allow function calls inside a table-level UNIQUE(...)
-- constraint, so this is a unique index on an expression instead.
CREATE UNIQUE INDEX friendships_unique_pair_idx
    ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE INDEX friendships_requester_idx ON friendships (requester_id);
CREATE INDEX friendships_addressee_idx ON friendships (addressee_id);

-- DM channels — modeled with a participants join table (not just two FK
-- columns) so group DMs (spec: up to 10 participants) fit the same schema
-- later without a migration; only 1:1 is created by the app today.
CREATE TABLE dm_channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    is_group        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dm_participants (
    dm_id           UUID NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id UUID,
    PRIMARY KEY (dm_id, user_id)
);

CREATE INDEX dm_participants_user_idx ON dm_participants (user_id);

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dm_id           UUID NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ
);

CREATE INDEX messages_dm_idx ON messages (dm_id, created_at);

-- Per-user notification sound preferences. Either a built-in preset key
-- (matches a filename shipped in the frontend's /public/sounds) or a
-- user-uploaded custom clip stored inline (small audio files only — no
-- object storage service exists yet, see spec Section 7.5/18, so this is
-- an intentional simplification, not the long-term design).
CREATE TABLE user_sound_settings (
    user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    message_sound_preset        TEXT,
    message_sound_custom        BYTEA,
    message_sound_custom_mime   TEXT,
    ringtone_preset             TEXT,
    ringtone_custom             BYTEA,
    ringtone_custom_mime        TEXT,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
