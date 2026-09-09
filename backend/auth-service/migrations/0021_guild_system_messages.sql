-- System messages (Discord-style "X joined the server") — piggybacks on
-- guild_messages rather than a separate table so they render inline in
-- channel history via the exact same list/pagination code path. sender_id
-- stays NOT NULL (it's set to the user who triggered the event, e.g. the
-- new member) and is_system just flags it for different rendering
-- (no avatar bubble, italic/muted style) client-side.
ALTER TABLE guild_messages ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
