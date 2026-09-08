-- Real file/image attachments on messages (DMs and guild channels). One
-- attachment per message, stored inline in Postgres — same "no object
-- storage service yet" simplification already used for guild icons and
-- custom notification sounds (see 0004_guilds.sql / 0003_friends_dms.sql).
-- A message can be text-only, attachment-only (content becomes ''), or
-- both, matching how Discord treats an image-with-caption post.

ALTER TABLE messages
    ADD COLUMN attachment_data BYTEA,
    ADD COLUMN attachment_mime TEXT,
    ADD COLUMN attachment_filename TEXT,
    ADD COLUMN attachment_size INT;

ALTER TABLE guild_messages
    ADD COLUMN attachment_data BYTEA,
    ADD COLUMN attachment_mime TEXT,
    ADD COLUMN attachment_filename TEXT,
    ADD COLUMN attachment_size INT;
