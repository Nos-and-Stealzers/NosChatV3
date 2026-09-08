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
/// missing/invalid), then look up the matching locally-synced user row.
///
/// A 404 here almost always means the Clerk webhook hasn't fired/succeeded
/// yet for this user (e.g. webhook misconfigured, or a timing race right
/// after sign-up) — check `/webhooks/clerk` delivery logs in the Clerk
/// dashboard before assuming this endpoint is broken.
pub async fn me(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<UserPublic>, (StatusCode, Json<serde_json::Value>)> {
    let user: Option<UserPublic> = sqlx::query_as(
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

    user.map(Json).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "no local user row yet — Clerk webhook may not have synced this user"
            })),
        )
    })
}

pub async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })))
}
