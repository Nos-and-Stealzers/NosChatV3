-- Guild audit log — records moderation/admin actions (Discord-style
-- "Audit Log" tab). append-only, no updates/deletes from app code.
-- actor_id nullable (SET NULL on delete) so a deleted user's past
-- actions stay visible instead of vanishing or blocking their deletion.
-- target_id is a loosely-typed UUID (may reference a user, channel, role,
-- etc. depending on action_type) rather than a FK to any one table, since
-- a single log table covers several different target kinds.

CREATE TABLE guild_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    action_type     TEXT NOT NULL,
    target_id       UUID,
    target_label    TEXT,
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX guild_audit_log_guild_idx ON guild_audit_log (guild_id, created_at DESC);
