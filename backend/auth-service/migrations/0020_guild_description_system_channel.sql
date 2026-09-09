-- Server description (shown in server settings / could back a future
-- discovery page) and a designated "system channel" — Discord's concept
-- of where automated join/leave messages post. system_channel_id is
-- nullable + ON DELETE SET NULL so deleting the channel doesn't orphan
-- the guild row or block the delete.
ALTER TABLE guilds ADD COLUMN description TEXT;
ALTER TABLE guilds ADD COLUMN system_channel_id UUID REFERENCES guild_channels(id) ON DELETE SET NULL;
