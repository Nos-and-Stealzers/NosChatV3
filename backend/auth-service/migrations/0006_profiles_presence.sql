-- User profiles + presence layer (Discord-style "About Me" + status dot).
--
-- Real presence (online/offline) is derived from actual live WebSocket
-- connections in ws.rs (WsHub already tracks that), not stored here.
-- What IS stored here is the user-settable *override* on top of that:
-- idle / dnd / invisible, plus a custom status message, bio, pronouns,
-- and an accent color for profile theming.

ALTER TABLE users
    ADD COLUMN bio              TEXT,
    ADD COLUMN pronouns         TEXT,
    ADD COLUMN accent_color     TEXT NOT NULL DEFAULT '#F4B740',
    ADD COLUMN status_text      TEXT,
    ADD COLUMN presence_mode    TEXT NOT NULL DEFAULT 'online'
        CHECK (presence_mode IN ('online', 'idle', 'dnd', 'invisible')),
    ADD COLUMN banner_color     TEXT NOT NULL DEFAULT '#1B1F27';

COMMENT ON COLUMN users.presence_mode IS
    'User-chosen override. Actual online/offline is derived from live WS connections in ws.rs; invisible means show offline to others regardless of real connection state.';
