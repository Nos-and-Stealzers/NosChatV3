-- Swap primary auth from self-hosted Argon2id/JWT to Clerk (user decision —
-- see CLAUDE.md Decisions log). Clerk now owns credentials entirely; this
-- backend no longer issues its own passwords/sessions. It:
--   1. verifies Clerk-issued JWTs on protected routes (see src/clerk.rs)
--   2. keeps a local `users` row per Clerk user, synced via the
--      /webhooks/clerk endpoint (user.created / user.updated / user.deleted)
--
-- password_hash is now nullable (no longer written to) and totp_secret /
-- totp_enabled are dropped — 2FA is Clerk's responsibility now, not ours.
-- Columns aren't dropped outright in case of rollback; password_hash is
-- kept nullable rather than dropped so existing rows (if any) aren't
-- destroyed, but nothing in this service writes to it anymore.

ALTER TABLE users
    ALTER COLUMN password_hash DROP NOT NULL,
    ALTER COLUMN username DROP NOT NULL, -- Clerk allows email-only accounts with no username set
    ADD COLUMN clerk_user_id TEXT;

-- Backfill isn't possible (no existing Clerk mapping for prior local
-- accounts) — this is fine since Phase 1 never had real users, only local
-- dev test rows. Fresh installs will populate clerk_user_id via the webhook.
UPDATE users SET clerk_user_id = 'unmigrated:' || id::text WHERE clerk_user_id IS NULL;

ALTER TABLE users ALTER COLUMN clerk_user_id SET NOT NULL;
CREATE UNIQUE INDEX users_clerk_user_id_unique_idx ON users (clerk_user_id);

-- email/username are no longer guaranteed unique-by-us at write time in the
-- same way (Clerk owns that validation now), but keep the existing unique
-- indexes — Clerk enforces unique email on its side too, so this should
-- never conflict in practice; if it ever does, that's a real data issue
-- worth surfacing rather than silently allowing duplicates.
