-- Staff/admin flag — a hard server-side gate, never client-settable. Only
-- two ways this column can ever become true:
--   1. This migration's one-time backfill (dev account, if it already
--      exists at migration time)
--   2. The auto-grant check in routes.rs::get_or_create_local_user and
--      webhooks.rs's user.created/user.updated sync, which force is_staff
--      = true ONLY when the synced email case-insensitively matches the
--      hardcoded dev account (stealzers.com@gmail.com) — never from any
--      user-supplied field, never via a public API. No endpoint anywhere
--      lets a client set this column; it's not part of any request body
--      this backend accepts.
ALTER TABLE users ADD COLUMN is_staff BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET is_staff = true WHERE lower(email) = 'stealzers.com@gmail.com';
