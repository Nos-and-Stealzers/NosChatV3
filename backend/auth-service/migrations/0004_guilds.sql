-- Guilds ("servers"), channels, roles, and invites — Discord-style
-- community layer on top of the existing friends/DM system. Guilds and DMs
-- are deliberately separate concerns: a guild's channels are NOT dm_channels
-- (no group-DM crossover), and guild messages live in their own table
-- (guild_messages) rather than overloading `messages`, since the two have
-- different membership/permission models (DM = participant list, guild =
-- role-based permissions) and diverging that now avoids a much messier
-- migration later once either grows real features.

-- ---------------------------------------------------------------------
-- Guilds
-- ---------------------------------------------------------------------
CREATE TABLE guilds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    -- Single uppercase-letter "icon" in the Discord style (no file upload
    -- pipeline exists yet — see user_sound_settings' BYTEA precedent if a
    -- real icon upload is ever added; this is an intentional simplification).
    icon_color      TEXT NOT NULL DEFAULT '#F0A868',
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guild_members (
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname        TEXT,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX guild_members_user_idx ON guild_members (user_id);

-- Bitfield permissions, Discord-style. Bit layout (least-significant first):
--   1   VIEW_CHANNELS
--   2   SEND_MESSAGES
--   4   MANAGE_MESSAGES   (delete/pin others' messages)
--   8   CONNECT           (join voice channels)
--   16  SPEAK             (unmute in voice — reserved for future use)
--   32  MANAGE_CHANNELS
--   64  MANAGE_ROLES
--   128 KICK_MEMBERS
--   256 BAN_MEMBERS       (reserved — no ban list exists yet, kick only)
--   512 MANAGE_GUILD      (rename/re-icon the guild, delete it)
--   1073741824 (bit 30)   ADMINISTRATOR — bypasses every other check
CREATE TABLE guild_roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#8B93A1',
    -- Higher position = higher precedence for display/color purposes.
    -- @everyone is always position 0 and cannot be deleted or reordered
    -- below itself; enforced at the application layer, not in SQL.
    position        INTEGER NOT NULL DEFAULT 0,
    permissions     BIGINT NOT NULL DEFAULT 0,
    is_default      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX guild_roles_guild_idx ON guild_roles (guild_id);
-- Exactly one @everyone (is_default) role per guild.
CREATE UNIQUE INDEX guild_roles_one_default_idx ON guild_roles (guild_id) WHERE is_default;

CREATE TABLE guild_member_roles (
    guild_id        UUID NOT NULL,
    user_id         UUID NOT NULL,
    role_id         UUID NOT NULL REFERENCES guild_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Channels
-- ---------------------------------------------------------------------
CREATE TABLE channel_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX channel_categories_guild_idx ON channel_categories (guild_id);

CREATE TABLE guild_channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES channel_categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'voice')),
    position        INTEGER NOT NULL DEFAULT 0,
    topic           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX guild_channels_guild_idx ON guild_channels (guild_id);

CREATE TABLE guild_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES guild_channels(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ
);

CREATE INDEX guild_messages_channel_idx ON guild_messages (channel_id, created_at);

-- ---------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------
CREATE TABLE guild_invites (
    code            TEXT PRIMARY KEY,
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- NULL = unlimited uses / never expires, matching Discord's defaults
    -- for a permanent invite link.
    max_uses        INTEGER,
    uses            INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX guild_invites_guild_idx ON guild_invites (guild_id);
