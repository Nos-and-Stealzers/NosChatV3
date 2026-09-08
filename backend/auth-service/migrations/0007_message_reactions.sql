-- Message reactions (emoji) for both DM and guild messages. One table
-- covers both since the shape is identical; message_id references
-- whichever table via a discriminator column rather than two separate
-- reaction tables, avoiding duplicated logic in every handler.
--
-- No FK to messages/guild_messages directly (a single FK can't
-- conditionally point at one of two tables) — referential integrity for
-- orphaned reactions is enforced in application code on message delete
-- (DELETE FROM message_reactions WHERE message_id = $1 runs in the same
-- transaction as the message delete).

CREATE TABLE message_reactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID NOT NULL,
    message_kind    TEXT NOT NULL CHECK (message_kind IN ('dm', 'guild')),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, message_kind, user_id, emoji)
);

CREATE INDEX message_reactions_message_idx ON message_reactions (message_id, message_kind);
