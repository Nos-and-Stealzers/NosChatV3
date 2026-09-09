-- Guild verification level — Discord-style gate on how "established" an
-- account must be before it can send messages in this guild. Kept to two
-- tiers (none/low) rather than Discord's full 5-tier ladder (which also
-- needs phone/email verification signals this app doesn't track) — low
-- maps to "account must be at least 10 minutes old", the one tier
-- meaningfully enforceable from data this schema already has
-- (users.created_at). 0 = off (default, no existing guild is affected).
ALTER TABLE guilds ADD COLUMN verification_level SMALLINT NOT NULL DEFAULT 0
    CHECK (verification_level IN (0, 1));
