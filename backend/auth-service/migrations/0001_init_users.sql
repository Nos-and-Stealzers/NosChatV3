-- Initial users table for NosChatV3 auth-service.
--
-- NOTE: written without the real NosChatV3-Spec-v2.md in hand (it's still not
-- in this repo — see CLAUDE.md Section 0/4). This is a reasonable standard
-- schema based on what CLAUDE.md documents about the intended auth model
-- (Argon2id password hashing, JWT sessions, TOTP + WebAuthn planned for
-- later). Reconcile against the real spec once it's available — in
-- particular, confirm field names/constraints and whether email verification,
-- soft-delete, or additional profile fields belong here vs. a separate table.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    username        TEXT NOT NULL,
    display_name    TEXT,
    password_hash   TEXT NOT NULL,
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,

    -- TOTP (2FA) — nullable until the user enables it. Secret is stored
    -- encrypted-at-rest in a real deployment; plain column here for now,
    -- flagged as a TODO once the spec's security section is available.
    totp_secret     TEXT,
    totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email));
CREATE UNIQUE INDEX users_username_unique_idx ON users (lower(username));

-- WebAuthn credentials — one user can register multiple authenticators
-- (e.g. a phone + a hardware key). Left minimal; expand once WebAuthn is
-- actually implemented (not yet — Phase 1 is password + JWT only).
CREATE TABLE webauthn_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   BYTEA NOT NULL,
    public_key      BYTEA NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    label           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX webauthn_credentials_credential_id_idx ON webauthn_credentials (credential_id);
CREATE INDEX webauthn_credentials_user_id_idx ON webauthn_credentials (user_id);
