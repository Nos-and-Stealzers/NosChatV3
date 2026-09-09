use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::clerk::ClerkUser;
use crate::AppState;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UserPublic {
    pub id: Uuid,
    pub clerk_user_id: String,
    pub email: String,
    pub username: Option<String>,
    pub is_staff: bool,
}

/// The ONLY email this backend will ever auto-grant staff to. Not
/// configurable via env/request — hardcoded on purpose so granting staff
/// access requires an actual code change + deploy, not a config file edit
/// or (worse) a request parameter. Case-insensitive compare on sync.
const DEV_STAFF_EMAIL: &str = "stealzers.com@gmail.com";

pub fn is_dev_staff_email(email: &str) -> bool {
    email.eq_ignore_ascii_case(DEV_STAFF_EMAIL)
}

/// Resolves a Clerk user's real primary email + username directly from
/// Clerk's Backend API (`GET /v1/users/:id`) using `CLERK_SECRET_KEY`.
/// This is the fallback path for when a local `users` row still has the
/// lazy-create placeholder email — normally that only happens because no
/// webhook endpoint is configured for this Clerk instance (see main.rs's
/// startup warning), so `user.created` never arrives. Calling the API
/// directly means real email/username shows up on the very next request
/// instead of staying wrong indefinitely.
async fn resolve_real_identity_from_clerk(
    state: &AppState,
    clerk_user_id: &str,
) -> Option<(String, Option<String>)> {
    let secret = state.clerk_secret_key.as_ref()?;
    let url = format!("https://api.clerk.com/v1/users/{clerk_user_id}");
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(secret)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        tracing::warn!(
            "Clerk Backend API lookup for {clerk_user_id} failed: {}",
            resp.status()
        );
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let primary_email_id = body.get("primary_email_address_id")?.as_str()?;
    let email = body
        .get("email_addresses")?
        .as_array()?
        .iter()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(primary_email_id))
        .and_then(|e| e.get("email_address"))
        .and_then(|v| v.as_str())?
        .to_string();
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some((email, username))
}

/// `GET /me` — the reference pattern for every future protected route:
/// require a verified Clerk JWT (via the `ClerkUser` extractor, which
/// rejects with 401 before the handler body even runs if the token is
/// missing/invalid), then look up the matching locally-synced user row —
/// lazily creating it if the webhook hasn't synced it yet (see
/// `get_or_create_local_user` below).
pub async fn me(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<UserPublic>, (StatusCode, Json<serde_json::Value>)> {
    let user = get_or_create_local_user(&state, &claims).await?;
    Ok(Json(user))
}

/// Looks up the local `users` row for a verified Clerk identity, creating it
/// on the fly if it doesn't exist yet.
///
/// Why this exists: the "correct" way to keep `users` in sync is the
/// `/webhooks/clerk` endpoint reacting to `user.created`. But that requires
/// a real `CLERK_WEBHOOK_SECRET` (dashboard endpoint + public URL, or the
/// `clerk webhooks listen` CLI relay) which may not be configured yet, and
/// even when it is, webhook delivery is asynchronous — a user can complete
/// sign-up and immediately hit an authenticated route before Clerk's webhook
/// has actually arrived. Either way, hard-failing (404/500) here would make
/// sign-in effectively broken for real users through no fault of their own.
///
/// Instead: since we've already verified the JWT (so `claims.sub`/`email`
/// are trustworthy, not user-supplied), we can safely upsert a local row
/// ourselves the first time we see a given `clerk_user_id`. This is a
/// permanent resilience path, not a workaround — it means the webhook
/// becomes an optimization (keeps username/email fresh, handles deletes)
/// rather than a hard dependency for basic auth to work.
pub async fn get_or_create_local_user(
    state: &AppState,
    claims: &crate::clerk::ClerkClaims,
) -> Result<UserPublic, (StatusCode, Json<serde_json::Value>)> {
    // Platform ban check — runs before anything else so a banned account
    // is rejected on every authenticated route (this is the single choke
    // point every protected handler goes through), not just a UI-hidden
    // affordance. Distinct from a per-guild ban in guild_bans.
    if let Ok(Some((true,))) = sqlx::query_as::<_, (bool,)>(
        "SELECT is_banned FROM users WHERE clerk_user_id = $1",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "this account has been banned" })),
        ));
    }

    let existing: Option<UserPublic> = sqlx::query_as(
        "SELECT id, clerk_user_id, email, username, is_staff FROM users WHERE clerk_user_id = $1",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!("failed to look up user {}: {e:#}", claims.sub);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
    })?;

    if let Some(user) = existing {
        // If this row still has the lazy-create placeholder email (i.e. the
        // Clerk webhook never delivered a user.created/updated event for
        // them — see main.rs's startup warning), resolve the real
        // email/username directly from Clerk's Backend API and heal the row
        // in place. This runs on every authenticated request until it
        // succeeds, same self-healing pattern as the staff-grant check
        // below, so a user isn't stuck with a placeholder email forever
        // just because the webhook was never configured.
        let user = if user.email.ends_with("@placeholder.noschat.local") {
            match resolve_real_identity_from_clerk(state, &claims.sub).await {
                Some((real_email, real_username)) => {
                    let healed: UserPublic = sqlx::query_as(
                        "UPDATE users SET email = $2, username = COALESCE(username, $3)
                         WHERE id = $1
                         RETURNING id, clerk_user_id, email, username, is_staff",
                    )
                    .bind(user.id)
                    .bind(&real_email)
                    .bind(&real_username)
                    .fetch_one(&state.db)
                    .await
                    .map_err(|e| {
                        tracing::error!("failed to heal placeholder email for {}: {e:#}", user.id);
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({ "error": "internal error" })),
                        )
                    })?;
                    tracing::info!(
                        "healed placeholder email for {} -> {} (resolved via Clerk Backend API)",
                        healed.id,
                        healed.email
                    );
                    healed
                }
                None => user,
            }
        } else {
            user
        };

        // Re-check staff eligibility on every authenticated request for an
        // existing row too — not just at creation. This means if the dev
        // account's row was created (e.g. by a placeholder email or before
        // this feature existed) it self-heals to is_staff=true the next
        // time they hit any authenticated route, without needing a manual
        // DB fix or waiting on a webhook.
        if !user.is_staff && is_dev_staff_email(&user.email) {
            let updated: UserPublic = sqlx::query_as(
                "UPDATE users SET is_staff = true WHERE id = $1
                 RETURNING id, clerk_user_id, email, username, is_staff",
            )
            .bind(user.id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| {
                tracing::error!("failed to grant staff to {}: {e:#}", user.id);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "internal error" })),
                )
            })?;
            tracing::info!("granted staff access to {} (dev account email match)", updated.id);
            let _ = crate::guilds::ensure_default_community_owner(state, updated.id).await;
            return Ok(updated);
        }
        if is_dev_staff_email(&user.email) {
            let _ = crate::guilds::ensure_default_community_owner(state, user.id).await;
        }
        return Ok(user);
    }

    // No local row yet. The JWT itself doesn't reliably carry an email
    // claim (Clerk's default session token template doesn't include one),
    // so try resolving it directly from Clerk's Backend API first; only
    // fall back to the placeholder if that's unavailable (no
    // CLERK_SECRET_KEY configured, or the API call fails) — a subsequent
    // webhook delivery (or the next request, which re-attempts the API
    // resolve above) will overwrite it with the real address.
    let resolved = resolve_real_identity_from_clerk(state, &claims.sub).await;
    let (email, username_from_clerk) = match resolved {
        Some((real_email, real_username)) => (real_email, real_username),
        None => (
            claims
                .email
                .clone()
                .unwrap_or_else(|| format!("{}@placeholder.noschat.local", claims.sub)),
            None,
        ),
    };

    tracing::info!(
        "lazily creating local user row for clerk_user_id={} (no webhook sync seen yet)",
        claims.sub
    );

    let user: UserPublic = sqlx::query_as(
        r#"
        INSERT INTO users (clerk_user_id, email, username, is_staff)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
        RETURNING id, clerk_user_id, email, username, is_staff
        "#,
    )
    .bind(&claims.sub)
    .bind(&email)
    .bind(&username_from_clerk)
    .bind(is_dev_staff_email(&email))
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        tracing::error!("failed to lazily create user {}: {e:#}", claims.sub);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
    })?;

    // Every brand-new user automatically lands in the shared default
    // community server (created on first-ever use if it doesn't exist
    // yet) with a real starter channel layout — matching how most
    // Discord-alike communities have one "town square" everyone's in from
    // the start, instead of a new signup starting with zero servers and
    // an empty friends list. Best-effort: a failure here shouldn't block
    // sign-in itself (the user's own row above already committed
    // successfully), just log it so it's visible without silently eating
    // real errors.
    if let Err(e) = crate::guilds::auto_join_default_guild(state, user.id).await {
        tracing::error!("failed to auto-join {} to the default community: {e:#}", user.id);
    }
    if is_dev_staff_email(&user.email) {
        let _ = crate::guilds::ensure_default_community_owner(state, user.id).await;
    }

    Ok(user)
}

pub async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })))
}
