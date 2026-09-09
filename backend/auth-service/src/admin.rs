//! Staff/admin endpoints — gated by `users.is_staff`, which can only ever
//! be set by the auto-grant logic in routes.rs/webhooks.rs (hardcoded dev
//! email match), never by any request body this backend accepts. See
//! migrations/0005_staff.sql for the schema-level doc comment.
//!
//! Every handler here re-checks is_staff itself (via `require_staff`) —
//! there's no separate "staff-only router" wrapper, so a copy-paste of a
//! new admin route can never accidentally skip the check the way a
//! forgotten middleware layer could.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::clerk::ClerkUser;
use crate::routes::get_or_create_local_user;
use crate::AppState;

type ApiError = (StatusCode, Json<Value>);

fn forbidden(msg: &str) -> ApiError {
    (StatusCode::FORBIDDEN, Json(json!({ "error": msg })))
}

fn internal_err(e: impl std::fmt::Display) -> ApiError {
    tracing::error!("admin: {e:#}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal error" })),
    )
}

/// Every admin handler calls this first. Uses the same lazy-sync path as
/// `/me` (so a staff member's row always exists/is current), then hard-403s
/// if `is_staff` isn't true — same failure mode whether the row doesn't
/// exist, the JWT is for a stranger, or a legitimate non-staff user hits
/// this by URL guessing. No information leak either way: a non-staff user
/// gets the exact same 403 body regardless of why.
async fn require_staff(state: &AppState, claims: &crate::clerk::ClerkClaims) -> Result<Uuid, ApiError> {
    let user = get_or_create_local_user(state, claims).await.map_err(|(code, body)| (code, body))?;
    if !user.is_staff {
        return Err(forbidden("staff access required"));
    }
    Ok(user.id)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AdminUserRow {
    pub id: Uuid,
    pub email: String,
    pub username: Option<String>,
    pub is_staff: bool,
    pub created_at: DateTime<Utc>,
}

/// `GET /admin/me` — lets the frontend cheaply check "am I staff" without
/// pulling the full user list. Returns 403 for non-staff, matching every
/// other admin route rather than a 200 with `{is_staff: false}` — a client
/// bug that ignores the boolean can never accidentally render the panel.
pub async fn admin_whoami(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Value>, ApiError> {
    let user_id = require_staff(&state, &claims).await?;
    Ok(Json(json!({ "is_staff": true, "user_id": user_id })))
}

/// `GET /admin/stats` — real counts, not decorative. Every number is a
/// live query, no caching (this is an admin panel, not a public dashboard —
/// a few extra COUNT(*) queries on demand are fine).
pub async fn admin_stats(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Value>, ApiError> {
    require_staff(&state, &claims).await?;

    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let (staff,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE is_staff")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let (guilds,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM guilds")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let (guild_channels,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM guild_channels")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let (guild_messages,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM guild_messages")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let (dm_messages,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let (friendships,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM friendships WHERE status = 'accepted'")
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let live_ws_connections = state.ws_hub.connection_count().await;

    Ok(Json(json!({
        "users": users,
        "staff": staff,
        "guilds": guilds,
        "guild_channels": guild_channels,
        "guild_messages": guild_messages,
        "dm_messages": dm_messages,
        "friendships": friendships,
        "live_ws_connections": live_ws_connections,
    })))
}

/// `GET /admin/users?limit=50&offset=0&q=search` — real search over
/// email/username, paginated so this stays usable once the user table is
/// large. Never returns password_hash (nullable/unused anyway) or any
/// Clerk token material — only what an admin panel actually needs to see.
pub async fn admin_list_users(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<AdminUserRow>>, ApiError> {
    require_staff(&state, &claims).await?;

    let limit: i64 = params.get("limit").and_then(|s| s.parse().ok()).unwrap_or(50).clamp(1, 200);
    let offset: i64 = params.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0).max(0);
    let q = params.get("q").map(|s| format!("%{}%", s.to_lowercase()));

    let rows: Vec<AdminUserRow> = if let Some(q) = q {
        sqlx::query_as(
            "SELECT id, email, username, is_staff, created_at FROM users
             WHERE lower(email) LIKE $1 OR lower(username) LIKE $1
             ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(q)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?
    } else {
        sqlx::query_as(
            "SELECT id, email, username, is_staff, created_at FROM users
             ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?
    };

    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AdminGuildRow {
    pub id: Uuid,
    pub name: String,
    pub owner_id: Uuid,
    pub owner_email: String,
    pub member_count: i64,
    pub created_at: DateTime<Utc>,
}

/// `GET /admin/guilds` — every guild on the instance, for moderation
/// visibility (e.g. spotting an abusive server before a report comes in).
pub async fn admin_list_guilds(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Vec<AdminGuildRow>>, ApiError> {
    require_staff(&state, &claims).await?;

    let rows: Vec<AdminGuildRow> = sqlx::query_as(
        r#"
        SELECT g.id, g.name, g.owner_id, u.email AS owner_email,
               (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count,
               g.created_at
        FROM guilds g
        JOIN users u ON u.id = g.owner_id
        ORDER BY g.created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}

/// `DELETE /admin/guilds/:id` — moderation action: force-delete any guild
/// regardless of ownership (unlike the regular DELETE /guilds/:id, which
/// only the owner can call). Real cascade via the same FK ON DELETE CASCADE
/// the owner-initiated path relies on (see 0004_guilds.sql).
pub async fn admin_delete_guild(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let admin_id = require_staff(&state, &claims).await?;

    let result = sqlx::query("DELETE FROM guilds WHERE id = $1")
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "guild not found" }))));
    }

    tracing::warn!("admin {admin_id} force-deleted guild {guild_id}");
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /admin/users/:id` — moderation action: remove a user's local
/// row entirely (their Clerk account is untouched — this only removes them
/// from NosChat's own data; a subsequent login would just lazily recreate a
/// fresh row via get_or_create_local_user). Cannot target another staff
/// account through this endpoint — a deliberate floor against one
/// compromised/malicious staff session nuking every other admin.
pub async fn admin_delete_user(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(target_user_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let admin_id = require_staff(&state, &claims).await?;

    if target_user_id == admin_id {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "can't delete your own account from here" }))));
    }

    let target_is_staff: Option<(bool,)> = sqlx::query_as("SELECT is_staff FROM users WHERE id = $1")
        .bind(target_user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    match target_is_staff {
        None => return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "user not found" })))),
        Some((true,)) => return Err(forbidden("cannot delete another staff account via this endpoint")),
        Some((false,)) => {}
    }

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(target_user_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    tracing::warn!("admin {admin_id} deleted user {target_user_id}");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize, Default)]
pub struct BanUserBody {
    #[serde(default)]
    pub reason: Option<String>,
}

/// `POST /admin/users/:id/ban` — platform-level ban: the account can no
/// longer authenticate at all (see get_or_create_local_user's is_banned
/// check in routes.rs), distinct from a per-guild ban in guild_bans. Same
/// self-protection floor as delete: can't target yourself or another
/// staff account through this endpoint.
pub async fn admin_ban_user(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(target_user_id): Path<Uuid>,
    body: Option<axum::Json<BanUserBody>>,
) -> Result<StatusCode, ApiError> {
    let admin_id = require_staff(&state, &claims).await?;

    if target_user_id == admin_id {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "can't ban your own account" }))));
    }

    let target_is_staff: Option<(bool,)> = sqlx::query_as("SELECT is_staff FROM users WHERE id = $1")
        .bind(target_user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    match target_is_staff {
        None => return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "user not found" })))),
        Some((true,)) => return Err(forbidden("cannot ban another staff account via this endpoint")),
        Some((false,)) => {}
    }

    let reason = body.map(|b| b.0.reason).unwrap_or(None);
    sqlx::query(
        "UPDATE users SET is_banned = true, banned_at = now(), banned_reason = $2, banned_by = $3
         WHERE id = $1",
    )
    .bind(target_user_id)
    .bind(&reason)
    .bind(admin_id)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    tracing::warn!("admin {admin_id} platform-banned user {target_user_id} (reason: {reason:?})");
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /admin/users/:id/ban` — lifts a platform ban.
pub async fn admin_unban_user(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(target_user_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let admin_id = require_staff(&state, &claims).await?;

    let result = sqlx::query(
        "UPDATE users SET is_banned = false, banned_at = NULL, banned_reason = NULL, banned_by = NULL
         WHERE id = $1",
    )
    .bind(target_user_id)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "user not found" }))));
    }

    tracing::warn!("admin {admin_id} lifted platform ban on user {target_user_id}");
    Ok(StatusCode::NO_CONTENT)
}
