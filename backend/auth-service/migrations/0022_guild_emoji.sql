-- Custom server emoji (Discord-style). Images stored inline in Postgres
-- like guild icon_image and user_sound_settings' custom clip — no object
-- storage service exists in this project yet, and emoji are small (32KB
-- cap) so inline storage is a fine fit at this scale.
CREATE TABLE guild_emoji (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (name ~ '^[a-zA-Z0-9_]{2,32}$'),
    image       BYTEA NOT NULL,
    image_mime  TEXT NOT NULL,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (guild_id, name)
);

CREATE INDEX guild_emoji_guild_idx ON guild_emoji (guild_id);
