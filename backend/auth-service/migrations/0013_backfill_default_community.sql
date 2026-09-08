-- One-off backfill: create the default community guild right now (if it
-- doesn't already exist) and join every existing user to it, so the
-- "everyone auto-joins on signup" feature also covers accounts that
-- signed up before this feature existed. New signups after this point
-- are handled automatically by auto_join_default_guild() in guilds.rs.

DO $$
DECLARE
    v_guild_id UUID;
    v_role_id UUID;
    v_welcome_cat UUID;
    v_community_cat UUID;
    v_owner_id UUID;
BEGIN
    SELECT id INTO v_guild_id FROM guilds WHERE is_default_community = true;

    IF v_guild_id IS NULL THEN
        SELECT id INTO v_owner_id FROM users ORDER BY created_at ASC LIMIT 1;
        IF v_owner_id IS NULL THEN
            RAISE NOTICE 'No users exist yet — nothing to backfill. The guild will be created on first signup.';
            RETURN;
        END IF;

        INSERT INTO guilds (name, icon_color, owner_id, is_default_community)
        VALUES ('NosChat Community', '#5FD9C4', v_owner_id, true)
        RETURNING id INTO v_guild_id;

        INSERT INTO guild_roles (guild_id, name, position, permissions, is_default)
        VALUES (v_guild_id, '@everyone', 0, (1 | 2 | 8 | 16), true)
        RETURNING id INTO v_role_id;

        INSERT INTO channel_categories (guild_id, name, position) VALUES (v_guild_id, 'WELCOME', 0) RETURNING id INTO v_welcome_cat;
        INSERT INTO channel_categories (guild_id, name, position) VALUES (v_guild_id, 'COMMUNITY', 1) RETURNING id INTO v_community_cat;

        INSERT INTO guild_channels (guild_id, category_id, name, kind, position) VALUES
            (v_guild_id, v_welcome_cat, 'welcome', 'text', 0),
            (v_guild_id, v_welcome_cat, 'rules', 'text', 1),
            (v_guild_id, v_welcome_cat, 'announcements', 'text', 2),
            (v_guild_id, v_community_cat, 'general', 'text', 0),
            (v_guild_id, v_community_cat, 'off-topic', 'text', 1),
            (v_guild_id, v_community_cat, 'General Voice', 'voice', 2),
            (v_guild_id, v_community_cat, 'Music', 'voice', 3);

        RAISE NOTICE 'Created default community guild %', v_guild_id;
    ELSE
        RAISE NOTICE 'Default community guild already exists: %', v_guild_id;
    END IF;

    SELECT id INTO v_role_id FROM guild_roles WHERE guild_id = v_guild_id AND is_default = true;

    -- Join every existing user who isn't already a member.
    INSERT INTO guild_members (guild_id, user_id)
    SELECT v_guild_id, u.id
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM guild_members gm WHERE gm.guild_id = v_guild_id AND gm.user_id = u.id
    )
    ON CONFLICT DO NOTHING;

    -- Assign @everyone role to anyone who was just backfilled without it.
    INSERT INTO guild_member_roles (guild_id, user_id, role_id)
    SELECT v_guild_id, u.id, v_role_id
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM guild_member_roles gmr
        WHERE gmr.guild_id = v_guild_id AND gmr.user_id = u.id AND gmr.role_id = v_role_id
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Backfill complete.';
END $$;
