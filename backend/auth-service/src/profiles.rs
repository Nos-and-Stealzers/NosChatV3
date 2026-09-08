//! Discord-style user profiles + presence.
//!
//! Schema: migrations/0006_profiles_presence.sql added
//! bio / pronouns / accent_color / status_text / presence_mode / banner_color
//! to `users`. Real online/offline is derived from live WebSocket
//! connections tracked in `ws.rs` (`WsHub`); `presence_mode` is the
//! user-chosen override layered on top of that (idle/dnd/invisible), same
//! as Discord's status dot semantics:
//!
//!   - no live connections               -> "offline", regardless of mode
//!   - live connections, mode invisible  -> shown to others as "offline"
//!   - live connections, mode online/idle/dnd -> shown as that mode
//!
//! This module owns:
//!   - GET  /users/:id        -- public profile view (anyone can view)
//!   - GET  /me/profile       -- your own full profile
//!   - PATCH /me/profile      -- edit bio/pronouns/colors/status_text
//!   - PUT  /me/presence      -- set presence_mode, broadcasts to friends
//!
//! and the presence broadcast helper (`broadcast_presence`) called from
//! `ws.rs` on socket connect/disconnect so friends see real-time
//! online/offline transitions without polling.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::clerk::ClerkUser;
use crate::AppState;

const VALID_MODES: [&str; 4] = ["online", "idle", "dnd", "invisible"];

fn internal_err(e: sqlx::Error) -> (StatusCode, Json<serde_json::Value>) {
    tracing::error!("db error: {e:#}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal error" })),
    )
}

async fn local_user_id(
    state: &AppState,
    clerk_sub: &str,
) -> Result<Uuid, (StatusCode, Json<serde_json::Value>)> {
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE clerk_user_id = $1")
        .bind(clerk_sub)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    row.map(|(id,)| id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no local user row yet" })),
        )
    })
}

#[derive(sqlx::FromRow)]
struct ProfileRow {
    id: Uuid,
    username: Option<String>,
    bio: Option<String>,
    pronouns: Option<String>,
    accent_color: String,
    banner_color: String,
    status_text: Option<String>,
    presence_mode: String,
}

/// Effective status shown to *other* users: "online" | "idle" | "dnd" | "offline".
/// Collapses `invisible` -> "offline" and forces "offline" whenever there
/// are no live WS connections, regardless of the stored mode.
pub async fn effective_status_pub(state: &AppState, user_id: Uuid, presence_mode: &str) -> String {
    effective_status(state, user_id, presence_mode).await
}

async fn effective_status(state: &AppState, user_id: Uuid, presence_mode: &str) -> String {
    if !state.ws_hub.is_online(user_id).await {
        return "offline".to_string();
    }
    if presence_mode == "invisible" {
        return "offline".to_string();
    }
    presence_mode.to_string()
}

#[derive(Serialize)]
pub struct PublicProfile {
    pub id: Uuid,
    pub username: Option<String>,
    pub bio: Option<String>,
    pub pronouns: Option<String>,
    pub accent_color: String,
    pub banner_color: String,
    pub status_text: Option<String>,
    /// What everyone else sees: online/idle/dnd/offline. Never "invisible"
    /// — invisible collapses to "offline" for anyone but the owner.
    pub status: String,
}

#[derive(Serialize)]
pub struct OwnProfile {
    pub id: Uuid,
    pub username: Option<String>,
    pub bio: Option<String>,
    pub pronouns: Option<String>,
    pub accent_color: String,
    pub banner_color: String,
    pub status_text: Option<String>,
    /// The raw stored mode (may be "invisible") — only exposed to the
    /// owner themself, since that's private preference, not public state.
    pub presence_mode: String,
    /// What everyone else currently sees for you (accounts for
    /// invisible + live-connection state), included for the owner's own
    /// UI to render its own status dot consistently with what others see.
    pub status: String,
}

async fn fetch_profile_row(
    state: &AppState,
    user_id: Uuid,
) -> Result<Option<ProfileRow>, (StatusCode, Json<serde_json::Value>)> {
    sqlx::query_as::<_, ProfileRow>(
        "SELECT id, username, bio, pronouns, accent_color, banner_color, status_text, presence_mode
         FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)
}

/// `GET /users/:id` — public profile view. Anyone with a verified session
/// can view anyone's profile (no friendship gating in v1, matching the
/// rest of this backend's "public within the app" model for usernames).
pub async fn get_public_profile(
    State(state): State<AppState>,
    ClerkUser(_claims): ClerkUser,
    Path(id): Path<Uuid>,
) -> Result<Json<PublicProfile>, (StatusCode, Json<serde_json::Value>)> {
    let Some(row) = fetch_profile_row(&state, id).await? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such user" })),
        ));
    };

    let status = effective_status(&state, row.id, &row.presence_mode).await;

    Ok(Json(PublicProfile {
        id: row.id,
        username: row.username,
        bio: row.bio,
        pronouns: row.pronouns,
        accent_color: row.accent_color,
        banner_color: row.banner_color,
        status_text: row.status_text,
        status,
    }))
}

/// `GET /me/profile` — your own full profile, including the raw
/// (possibly "invisible") presence_mode.
pub async fn get_own_profile(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<OwnProfile>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    let Some(row) = fetch_profile_row(&state, me).await? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no local user row yet" })),
        ));
    };

    let status = effective_status(&state, row.id, &row.presence_mode).await;

    Ok(Json(OwnProfile {
        id: row.id,
        username: row.username,
        bio: row.bio,
        pronouns: row.pronouns,
        accent_color: row.accent_color,
        banner_color: row.banner_color,
        status_text: row.status_text,
        presence_mode: row.presence_mode,
        status,
    }))
}

/// Body for `PATCH /me/profile`. Every field optional — only supplied
/// fields are updated (`Option<Option<T>>` would let you explicitly clear
/// bio/pronouns/status_text to null, but plain `Option<T>` covers the
/// common "set a value" case; a present-but-empty-string value clears the
/// field in practice since the frontend can send "").
#[derive(Deserialize, Default)]
pub struct UpdateProfileBody {
    pub bio: Option<String>,
    pub pronouns: Option<String>,
    pub accent_color: Option<String>,
    pub banner_color: Option<String>,
    pub status_text: Option<String>,
}

fn is_valid_hex_color(s: &str) -> bool {
    s.len() == 7
        && s.starts_with('#')
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

const MAX_BIO_LEN: usize = 190;
const MAX_PRONOUNS_LEN: usize = 40;
const MAX_STATUS_TEXT_LEN: usize = 128;

/// `PATCH /me/profile` `{ bio?, pronouns?, accent_color?, banner_color?, status_text? }`
pub async fn update_profile(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Json(body): Json<UpdateProfileBody>,
) -> Result<Json<OwnProfile>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    if let Some(bio) = &body.bio {
        if bio.chars().count() > MAX_BIO_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("bio must be at most {MAX_BIO_LEN} characters") })),
            ));
        }
    }
    if let Some(pronouns) = &body.pronouns {
        if pronouns.chars().count() > MAX_PRONOUNS_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("pronouns must be at most {MAX_PRONOUNS_LEN} characters") })),
            ));
        }
    }
    if let Some(status_text) = &body.status_text {
        if status_text.chars().count() > MAX_STATUS_TEXT_LEN {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("status_text must be at most {MAX_STATUS_TEXT_LEN} characters") })),
            ));
        }
    }
    if let Some(color) = &body.accent_color {
        if !is_valid_hex_color(color) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "accent_color must be a hex color like #F4B740" })),
            ));
        }
    }
    if let Some(color) = &body.banner_color {
        if !is_valid_hex_color(color) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "banner_color must be a hex color like #1B1F27" })),
            ));
        }
    }

    let row: ProfileRow = sqlx::query_as(
        r#"
        UPDATE users SET
            bio           = COALESCE($2, bio),
            pronouns      = COALESCE($3, pronouns),
            accent_color  = COALESCE($4, accent_color),
            banner_color  = COALESCE($5, banner_color),
            status_text   = COALESCE($6, status_text)
        WHERE id = $1
        RETURNING id, username, bio, pronouns, accent_color, banner_color, status_text, presence_mode
        "#,
    )
    .bind(me)
    .bind(&body.bio)
    .bind(&body.pronouns)
    .bind(&body.accent_color)
    .bind(&body.banner_color)
    .bind(&body.status_text)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;

    let status = effective_status(&state, row.id, &row.presence_mode).await;

    // status_text is visible on the profile others see, so friends should
    // get a live update even though presence_mode itself didn't change.
    broadcast_presence(&state, row.id, &status, row.status_text.clone()).await;

    Ok(Json(OwnProfile {
        id: row.id,
        username: row.username,
        bio: row.bio,
        pronouns: row.pronouns,
        accent_color: row.accent_color,
        banner_color: row.banner_color,
        status_text: row.status_text,
        presence_mode: row.presence_mode,
        status,
    }))
}

#[derive(Deserialize)]
pub struct SetPresenceBody {
    /// One of "online" | "idle" | "dnd" | "invisible".
    pub mode: String,
}

/// `PUT /me/presence` `{ "mode": "idle" }` — sets the user-chosen presence
/// override and broadcasts the resulting *effective* status to friends
/// over WS. Does not require the user to actually be connected via WS to
/// set this (e.g. changing it via a REST client before opening a socket)
/// — it just won't show as anything but offline until they do connect.
pub async fn set_presence(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Json(body): Json<SetPresenceBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    if !VALID_MODES.contains(&body.mode.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("mode must be one of {VALID_MODES:?}") })),
        ));
    }

    let row: (String, Option<String>) = sqlx::query_as(
        "UPDATE users SET presence_mode = $2 WHERE id = $1 RETURNING presence_mode, status_text",
    )
    .bind(me)
    .bind(&body.mode)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;

    let status = effective_status(&state, me, &row.0).await;
    broadcast_presence(&state, me, &status, row.1).await;

    Ok(Json(json!({ "presence_mode": row.0, "status": status })))
}

/// Every accepted-friendship counterpart of `user_id` — the fan-out list
/// for presence broadcasts. Mirrors the join in `friends::list_friends`.
async fn friend_ids(state: &AppState, user_id: Uuid) -> Vec<Uuid> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        r#"
        SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END
        FROM friendships
        WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!("failed to look up friends for presence broadcast: {e:#}");
        Vec::new()
    });
    rows.into_iter().map(|(id,)| id).collect()
}

/// Sends a `presence_update` event to every friend of `user_id`. Called
/// from `ws.rs` on connect/disconnect (real presence changes) and from
/// this module on explicit presence-mode / status_text changes.
pub async fn broadcast_presence(
    state: &AppState,
    user_id: Uuid,
    status: &str,
    status_text: Option<String>,
) {
    let friends = friend_ids(state, user_id).await;
    if friends.is_empty() {
        return;
    }
    let payload = json!({
        "type": "presence_update",
        "user_id": user_id,
        "status": status,
        "status_text": status_text,
    });
    state.ws_hub.send_to_many(&friends, payload).await;
}
