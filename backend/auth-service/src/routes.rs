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
    let existing: Option<UserPublic> = sqlx::query_as(
        "SELECT id, clerk_user_id, email, username FROM users WHERE clerk_user_id = $1",
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
        return Ok(user);
    }

    // No local row yet. The JWT itself doesn't reliably carry an email
    // claim (Clerk's default session token template doesn't include one),
    // so if it's missing here we fall back to a clearly-marked placeholder
    // rather than failing — a subsequent webhook delivery (or the next
    // manual sync) will overwrite it with the real address via the
    // `ON CONFLICT ... DO UPDATE` in webhooks.rs.
    let email = claims
        .email
        .clone()
        .unwrap_or_else(|| format!("{}@placeholder.noschat.local", claims.sub));

    tracing::info!(
        "lazily creating local user row for clerk_user_id={} (no webhook sync seen yet)",
        claims.sub
    );

    let user: UserPublic = sqlx::query_as(
        r#"
        INSERT INTO users (clerk_user_id, email, username)
        VALUES ($1, $2, NULL)
        ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
        RETURNING id, clerk_user_id, email, username
        "#,
    )
    .bind(&claims.sub)
    .bind(&email)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        tracing::error!("failed to lazily create user {}: {e:#}", claims.sub);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal error" })),
        )
    })?;

    Ok(user)
}

pub async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })))
}
