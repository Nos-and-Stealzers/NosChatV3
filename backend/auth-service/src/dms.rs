//! Direct messages between friends. See master spec Sections 9.3 and 12.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::clerk::ClerkUser;
use crate::AppState;

async fn local_user_id(state: &AppState, clerk_sub: &str) -> Result<Uuid, (StatusCode, Json<serde_json::Value>)> {
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

fn internal_err(e: sqlx::Error) -> (StatusCode, Json<serde_json::Value>) {
    tracing::error!("db error: {e:#}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal error" })),
    )
}

async fn are_friends(state: &AppState, a: Uuid, b: Uuid) -> Result<bool, sqlx::Error> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM friendships
         WHERE status = 'accepted'
           AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.is_some())
}

#[derive(Deserialize)]
pub struct OpenDmBody {
    pub friend_user_id: Uuid,
}

/// `POST /dms` `{ "friend_user_id": "..." }` — get-or-create the 1:1 DM
/// channel with a friend. Only allowed once you're actually friends.
pub async fn open_dm(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Json(body): Json<OpenDmBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    let other = body.friend_user_id;

    if !are_friends(&state, me, other).await.map_err(internal_err)? {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can only DM accepted friends" })),
        ));
    }

    // Look for an existing 1:1 (non-group) DM containing exactly these two
    // participants.
    let existing: Option<(Uuid,)> = sqlx::query_as(
        r#"
        SELECT dm_id FROM (
            SELECT dm_id, array_agg(user_id ORDER BY user_id) AS members
            FROM dm_participants
            GROUP BY dm_id
        ) grouped
        JOIN dm_channels c ON c.id = grouped.dm_id AND c.is_group = false
        WHERE members = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[$1, $2]) x)
        "#,
    )
    .bind(me)
    .bind(other)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let dm_id = if let Some((id,)) = existing {
        id
    } else {
        let mut tx = state.db.begin().await.map_err(internal_err)?;
        let (id,): (Uuid,) = sqlx::query_as("INSERT INTO dm_channels DEFAULT VALUES RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .map_err(internal_err)?;
        sqlx::query("INSERT INTO dm_participants (dm_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(id)
            .bind(me)
            .bind(other)
            .execute(&mut *tx)
            .await
            .map_err(internal_err)?;
        tx.commit().await.map_err(internal_err)?;
        id
    };

    Ok(Json(json!({ "id": dm_id })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DmSummary {
    pub id: Uuid,
    pub other_user_id: Option<Uuid>,
    pub other_username: Option<String>,
    pub other_email: Option<String>,
    pub last_message: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub unread_count: i64,
}

/// `GET /dms` — every DM channel you're in, with the other participant
/// (1:1 only — group DM listing isn't built yet), a preview, and how many
/// messages from the other person are unread (messages after your
/// `last_read_message_id`, or all of them if you've never read this DM).
pub async fn list_dms(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Vec<DmSummary>>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    let rows: Vec<DmSummary> = sqlx::query_as(
        r#"
        SELECT
            c.id,
            u.id AS other_user_id,
            u.username AS other_username,
            u.email AS other_email,
            lm.content AS last_message,
            lm.created_at AS last_message_at,
            COALESCE(unread.cnt, 0) AS unread_count
        FROM dm_channels c
        JOIN dm_participants me_p ON me_p.dm_id = c.id AND me_p.user_id = $1
        LEFT JOIN dm_participants other_p ON other_p.dm_id = c.id AND other_p.user_id <> $1
        LEFT JOIN users u ON u.id = other_p.user_id
        LEFT JOIN LATERAL (
            SELECT content, created_at FROM messages m
            WHERE m.dm_id = c.id ORDER BY m.created_at DESC LIMIT 1
        ) lm ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS cnt FROM messages m2
            WHERE m2.dm_id = c.id
              AND m2.sender_id <> $1
              AND (
                me_p.last_read_message_id IS NULL
                OR m2.created_at > (
                    SELECT created_at FROM messages WHERE id = me_p.last_read_message_id
                )
              )
        ) unread ON true
        WHERE c.is_group = false
        ORDER BY COALESCE(lm.created_at, c.created_at) DESC
        "#,
    )
    .bind(me)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MessageView {
    pub id: Uuid,
    pub dm_id: Uuid,
    pub sender_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
}

async fn assert_participant(state: &AppState, dm_id: Uuid, user_id: Uuid) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT dm_id FROM dm_participants WHERE dm_id = $1 AND user_id = $2")
        .bind(dm_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    if row.is_none() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not a participant in this DM" })),
        ));
    }
    Ok(())
}

/// `GET /dms/:id/messages` — most recent 50, oldest first.
pub async fn list_messages(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
) -> Result<Json<Vec<MessageView>>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let rows: Vec<MessageView> = sqlx::query_as(
        r#"
        SELECT * FROM (
            SELECT id, dm_id, sender_id, content, created_at, edited_at
            FROM messages WHERE dm_id = $1
            ORDER BY created_at DESC LIMIT 50
        ) recent ORDER BY created_at ASC
        "#,
    )
    .bind(dm_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct SendMessageBody {
    pub content: String,
}

/// `POST /dms/:id/messages` — persists the message and pushes it over the
/// WebSocket hub to every participant's live connections (including the
/// sender's other tabs/devices).
pub async fn send_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
    Json(body): Json<SendMessageBody>,
) -> Result<Json<MessageView>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let content = body.content.trim();
    if content.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "message can't be empty" })),
        ));
    }
    if content.chars().count() > 4000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "message too long (max 4000 characters)" })),
        ));
    }

    let msg: MessageView = sqlx::query_as(
        "INSERT INTO messages (dm_id, sender_id, content) VALUES ($1, $2, $3)
         RETURNING id, dm_id, sender_id, content, created_at, edited_at",
    )
    .bind(dm_id)
    .bind(me)
    .bind(content)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;

    // The sender has, by definition, "read" their own message — advance
    // their own read pointer too so their unread_count for this DM doesn't
    // tick up from their own send.
    sqlx::query("UPDATE dm_participants SET last_read_message_id = $1 WHERE dm_id = $2 AND user_id = $3")
        .bind(msg.id)
        .bind(dm_id)
        .bind(me)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    let participants: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();

    let payload = json!({ "type": "message", "message": &msg });
    state.ws_hub.send_to_many(&recipient_ids, payload).await;

    Ok(Json(msg))
}

/// `POST /dms/:id/read` — marks every message in the DM as read for the
/// caller (advances `last_read_message_id` to the latest message). No body;
/// called by the frontend when a DM is opened and while it stays the active
/// view as new messages arrive in it.
pub async fn mark_read(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let latest: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM messages WHERE dm_id = $1 ORDER BY created_at DESC LIMIT 1")
            .bind(dm_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;

    if let Some((last_id,)) = latest {
        sqlx::query(
            "UPDATE dm_participants SET last_read_message_id = $1 WHERE dm_id = $2 AND user_id = $3",
        )
        .bind(last_id)
        .bind(dm_id)
        .bind(me)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;
    }

    Ok(Json(json!({ "status": "ok" })))
}
