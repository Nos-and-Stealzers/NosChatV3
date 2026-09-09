-- Optional user-set display name for group DMs (Discord-style "New Group
-- DM" — created without a name, shows joined participant names until the
-- creator/a member renames it). NULL for 1:1 DMs and unnamed group DMs.
ALTER TABLE dm_channels ADD COLUMN name TEXT;
