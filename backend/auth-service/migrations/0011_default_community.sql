-- Default community server — every new user is automatically joined to
-- exactly one shared guild on account creation, matching how most
-- Discord-alike apps/communities have a single "town square" everyone
-- lands in. `is_default_community` marks which guild that is; a partial
-- unique index guarantees at most one exists even under concurrent
-- creation attempts (see guilds::get_or_create_default_guild).

ALTER TABLE guilds
    ADD COLUMN is_default_community BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX guilds_one_default_community_idx
    ON guilds (is_default_community) WHERE is_default_community;
