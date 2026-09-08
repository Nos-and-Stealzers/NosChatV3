-- Guild icon image upload — same inline-BYTEA pattern as
-- user_sound_settings' custom sound uploads (no object storage service
-- exists yet, see that table's comment for the same intentional-
-- simplification rationale). NULL means "use icon_color instead", so
-- existing guilds keep working unchanged with zero data migration.

ALTER TABLE guilds
    ADD COLUMN icon_image      BYTEA,
    ADD COLUMN icon_image_mime TEXT;
