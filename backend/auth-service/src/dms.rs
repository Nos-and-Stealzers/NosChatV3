//! Direct messages between friends. See master spec Sections 9.3 and 12.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::clerk::ClerkUser;
use crate::AppState;

/// Attachments (DMs and guild channels) share this cap — generous enough
/// for real images/short clips/small documents while staying sane for
/// inline Postgres storage (no object storage service exists yet, same
/// simplification as guild icons / custom notification sounds).
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

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
    pub is_group: bool,
    pub name: Option<String>,
    /// 1:1 only — kept for backward compatibility with existing frontend
    /// code that renders 1:1 DMs by these fields directly.
    pub other_user_id: Option<Uuid>,
    pub other_username: Option<String>,
    pub other_email: Option<String>,
    /// All participants other than the caller, id + display name — used
    /// for group DMs (and usable for 1:1 too) to build a display label
    /// without a dedicated name column being required.
    #[sqlx(skip)]
    pub participants: Vec<DmParticipantView>,
    pub last_message: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub unread_count: i64,
}

#[derive(Serialize, Clone)]
pub struct DmParticipantView {
    pub user_id: Uuid,
    pub username: Option<String>,
    pub email: String,
}

/// Row shape actually selected for the DM list — participants are
/// aggregated separately per-DM below since they're 1:N.
#[derive(sqlx::FromRow)]
struct DmSummaryRow {
    id: Uuid,
    is_group: bool,
    name: Option<String>,
    other_user_id: Option<Uuid>,
    other_username: Option<String>,
    other_email: Option<String>,
    last_message: Option<String>,
    last_message_at: Option<DateTime<Utc>>,
    unread_count: i64,
}

/// `GET /dms` — every DM channel you're in (1:1 and group), with a
/// preview and how many messages are unread (messages after your
/// `last_read_message_id`, or all of them if you've never read this DM).
/// For 1:1 DMs, `other_user_id`/`other_username`/`other_email` are also
/// populated for backward compatibility; group DMs additionally carry the
/// full `participants` list (everyone but the caller) so the frontend can
/// build a "Alice, Bob, Carol" style label, or use `name` if the group
/// has been explicitly renamed.
pub async fn list_dms(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Vec<DmSummary>>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    let rows: Vec<DmSummaryRow> = sqlx::query_as(
        r#"
        SELECT
            c.id,
            c.is_group,
            c.name,
            u.id AS other_user_id,
            u.username AS other_username,
            u.email AS other_email,
            lm.content AS last_message,
            lm.created_at AS last_message_at,
            COALESCE(unread.cnt, 0) AS unread_count
        FROM dm_channels c
        JOIN dm_participants me_p ON me_p.dm_id = c.id AND me_p.user_id = $1
        LEFT JOIN dm_participants other_p ON other_p.dm_id = c.id AND other_p.user_id <> $1 AND c.is_group = false
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
        ORDER BY COALESCE(lm.created_at, c.created_at) DESC
        "#,
    )
    .bind(me)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    // Fetch participants (other than the caller) for every group DM in one
    // query, then fold them onto the corresponding summary row.
    let group_ids: Vec<Uuid> = rows.iter().filter(|r| r.is_group).map(|r| r.id).collect();
    let participant_rows: Vec<(Uuid, Uuid, Option<String>, String)> = if group_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            r#"
            SELECT p.dm_id, u.id, u.username, u.email
            FROM dm_participants p
            JOIN users u ON u.id = p.user_id
            WHERE p.dm_id = ANY($1) AND p.user_id <> $2
            ORDER BY u.username NULLS LAST, u.email
            "#,
        )
        .bind(&group_ids)
        .bind(me)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?
    };

    let summaries = rows
        .into_iter()
        .map(|r| {
            let participants: Vec<DmParticipantView> = participant_rows
                .iter()
                .filter(|(dm_id, ..)| *dm_id == r.id)
                .map(|(_, user_id, username, email)| DmParticipantView {
                    user_id: *user_id,
                    username: username.clone(),
                    email: email.clone(),
                })
                .collect();
            DmSummary {
                id: r.id,
                is_group: r.is_group,
                name: r.name,
                other_user_id: r.other_user_id,
                other_username: r.other_username,
                other_email: r.other_email,
                participants,
                last_message: r.last_message,
                last_message_at: r.last_message_at,
                unread_count: r.unread_count,
            }
        })
        .collect();

    Ok(Json(summaries))
}

#[derive(Deserialize)]
pub struct CreateGroupDmBody {
    /// The other participants (not including the caller). 2-9 entries, so
    /// the resulting DM has 3-10 total participants including the caller.
    pub friend_user_ids: Vec<Uuid>,
}

/// `POST /dms/group` `{ "friend_user_ids": ["...", "..."] }` — creates a
/// new group DM (`is_group = true`) with the caller plus every listed
/// friend. Unlike 1:1 `open_dm`, this always creates a new channel (no
/// get-or-create dedup — Discord itself lets you create multiple distinct
/// group DMs with the same members). All listed users must be accepted
/// friends of the caller.
pub async fn create_group_dm(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Json(body): Json<CreateGroupDmBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    // De-dupe and drop the caller if they somehow included themselves.
    let mut others: Vec<Uuid> = body.friend_user_ids.into_iter().filter(|id| *id != me).collect();
    others.sort();
    others.dedup();

    if others.len() < 2 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a group DM needs at least 2 other friends" })),
        ));
    }
    if others.len() > 9 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a group DM allows at most 10 participants total" })),
        ));
    }

    for other in &others {
        if !are_friends(&state, me, *other).await.map_err(internal_err)? {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "you can only start a group DM with accepted friends" })),
            ));
        }
    }

    let mut tx = state.db.begin().await.map_err(internal_err)?;
    let (dm_id,): (Uuid,) = sqlx::query_as("INSERT INTO dm_channels (is_group) VALUES (true) RETURNING id")
        .fetch_one(&mut *tx)
        .await
        .map_err(internal_err)?;

    sqlx::query("INSERT INTO dm_participants (dm_id, user_id) VALUES ($1, $2)")
        .bind(dm_id)
        .bind(me)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;
    for other in &others {
        sqlx::query("INSERT INTO dm_participants (dm_id, user_id) VALUES ($1, $2)")
            .bind(dm_id)
            .bind(other)
            .execute(&mut *tx)
            .await
            .map_err(internal_err)?;
    }

    tx.commit().await.map_err(internal_err)?;

    Ok(Json(json!({ "id": dm_id })))
}

#[derive(Deserialize)]
pub struct RenameGroupDmBody {
    /// Empty/whitespace-only clears the name back to the default
    /// "joined participant names" display.
    pub name: Option<String>,
}

/// `PATCH /dms/:id/name` `{ "name": "..." }` — renames a group DM. Any
/// participant may rename it (matches Discord's default group DM
/// permissions — no dedicated "owner" concept exists in this schema).
/// 1:1 DMs can't be renamed.
pub async fn rename_group_dm(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
    Json(body): Json<RenameGroupDmBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let is_group: Option<(bool,)> = sqlx::query_as("SELECT is_group FROM dm_channels WHERE id = $1")
        .bind(dm_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    if !matches!(is_group, Some((true,))) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "only group DMs can be renamed" })),
        ));
    }

    let name = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query("UPDATE dm_channels SET name = $2 WHERE id = $1")
        .bind(dm_id)
        .bind(name)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    let participants: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({ "type": "dm_renamed", "dm_id": dm_id, "name": name })).await;

    Ok(Json(json!({ "id": dm_id, "name": name })))
}

#[derive(Deserialize)]
pub struct AddParticipantBody {
    pub user_id: Uuid,
}

/// `POST /dms/:id/participants` — adds a friend to an existing group DM.
/// Any current participant may add someone (matches rename's "no owner"
/// permission model). The new participant must be a friend of the
/// inviter (same trust bar as creating the group in the first place),
/// and the 10-person cap from create_group_dm applies here too.
pub async fn add_group_dm_participant(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
    Json(body): Json<AddParticipantBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let is_group: Option<(bool,)> = sqlx::query_as("SELECT is_group FROM dm_channels WHERE id = $1")
        .bind(dm_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    if !matches!(is_group, Some((true,))) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "only group DMs support adding participants" })),
        ));
    }

    if !are_friends(&state, me, body.user_id).await.map_err(internal_err)? {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can only add accepted friends to a group" })),
        ));
    }

    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    if count.0 >= 10 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a group DM allows at most 10 participants total" })),
        ));
    }

    sqlx::query("INSERT INTO dm_participants (dm_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(dm_id)
        .bind(body.user_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    let participants: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "dm_participant_added", "dm_id": dm_id, "user_id": body.user_id,
    })).await;

    Ok(Json(json!({ "status": "ok" })))
}

/// `DELETE /dms/:id/participants/me` — leave a group DM (removes yourself,
/// matching Discord's "Leave Group" action). 1:1 DMs can't be left this
/// way — there's no concept of leaving a 1:1 conversation, only closing
/// it client-side, which this app doesn't model server-side at all.
pub async fn leave_group_dm(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let is_group: Option<(bool,)> = sqlx::query_as("SELECT is_group FROM dm_channels WHERE id = $1")
        .bind(dm_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    if !matches!(is_group, Some((true,))) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "only group DMs can be left — 1:1 conversations can't" })),
        ));
    }

    let remaining: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1 AND user_id != $2")
        .bind(dm_id)
        .bind(me)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;

    sqlx::query("DELETE FROM dm_participants WHERE dm_id = $1 AND user_id = $2")
        .bind(dm_id)
        .bind(me)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    let recipient_ids: Vec<Uuid> = remaining.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "dm_participant_left", "dm_id": dm_id, "user_id": me,
    })).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MessageView {
    pub id: Uuid,
    pub dm_id: Uuid,
    pub sender_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reply_to_message_id: Option<Uuid>,
    #[sqlx(skip)]
    pub reply_to: Option<ReplyPreview>,
    #[sqlx(skip)]
    pub attachment: Option<AttachmentMeta>,
}

#[derive(Serialize, Clone)]
pub struct ReplyPreview {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub content: String,
}

#[derive(Serialize)]
pub struct AttachmentMeta {
    pub filename: String,
    pub mime: String,
    pub size: i32,
}

/// Row shape actually selected from the DB (raw attachment columns before
/// they're folded into MessageView's `attachment` field below).
#[derive(sqlx::FromRow)]
struct MessageRow {
    id: Uuid,
    dm_id: Uuid,
    sender_id: Uuid,
    content: String,
    created_at: DateTime<Utc>,
    edited_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    reply_to_message_id: Option<Uuid>,
    attachment_mime: Option<String>,
    attachment_filename: Option<String>,
    attachment_size: Option<i32>,
}

impl From<MessageRow> for MessageView {
    fn from(r: MessageRow) -> Self {
        let attachment = match (r.attachment_mime, r.attachment_filename, r.attachment_size) {
            (Some(mime), Some(filename), Some(size)) => Some(AttachmentMeta { filename, mime, size }),
            _ => None,
        };
        MessageView {
            id: r.id,
            dm_id: r.dm_id,
            sender_id: r.sender_id,
            content: r.content,
            created_at: r.created_at,
            edited_at: r.edited_at,
            reply_to_message_id: r.reply_to_message_id,
            reply_to: None,
            attachment,
        }
    }
}

/// Best-effort fetch of a short preview (sender + truncated content) for
/// whatever message `reply_to_message_id` points at, so the frontend can
/// render a quoted-reply strip without a second round trip per message.
/// Returns None silently if the original was deleted or the id is unset —
/// never blocks the actual message send/list on this.
async fn fetch_reply_preview(state: &AppState, reply_to_message_id: Option<Uuid>) -> Option<ReplyPreview> {
    let id = reply_to_message_id?;
    let row: Option<(Uuid, String)> = sqlx::query_as("SELECT sender_id, content FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .ok()?;
    let (sender_id, content) = row?;
    Some(ReplyPreview {
        id,
        sender_id,
        content: content.chars().take(200).collect(),
    })
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

    let rows: Vec<MessageRow> = sqlx::query_as(
        r#"
        SELECT * FROM (
            SELECT id, dm_id, sender_id, content, created_at, edited_at, reply_to_message_id,
                   attachment_mime, attachment_filename, attachment_size
            FROM messages WHERE dm_id = $1
            ORDER BY created_at DESC LIMIT 50
        ) recent ORDER BY created_at ASC
        "#,
    )
    .bind(dm_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let mut views: Vec<MessageView> = rows.into_iter().map(MessageView::from).collect();
    for v in &mut views {
        if v.reply_to_message_id.is_some() {
            v.reply_to = fetch_reply_preview(&state, v.reply_to_message_id).await;
        }
    }

    Ok(Json(views))
}

#[derive(Deserialize)]
pub struct EditMessageBody {
    pub content: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ReactionSummary {
    pub emoji: String,
    pub count: i64,
    pub reacted_by_me: bool,
}

/// `PATCH /dms/:dm_id/messages/:message_id` — only the original sender may
/// edit; sets `edited_at`, broadcasts a `message_edited` event to every
/// participant.
pub async fn edit_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((dm_id, message_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<EditMessageBody>,
) -> Result<Json<MessageView>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let content = body.content.trim();
    if content.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "message can't be empty" }))));
    }
    if content.chars().count() > 4000 {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "message too long (max 4000 characters)" }))));
    }

    let row: Option<MessageRow> = sqlx::query_as(
        "UPDATE messages SET content = $3, edited_at = now()
         WHERE id = $1 AND dm_id = $2 AND sender_id = $4
         RETURNING id, dm_id, sender_id, content, created_at, edited_at, reply_to_message_id, attachment_mime, attachment_filename, attachment_size",
    )
    .bind(message_id)
    .bind(dm_id)
    .bind(content)
    .bind(me)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some(row) = row else {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "not found, or you're not the sender" }))));
    };
    let mut msg = MessageView::from(row);
    msg.reply_to = fetch_reply_preview(&state, msg.reply_to_message_id).await;

    let participants: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({ "type": "message_edited", "message": &msg })).await;

    Ok(Json(msg))
}

/// `DELETE /dms/:dm_id/messages/:message_id` — only the original sender may
/// delete. Also cleans up any reactions on it and broadcasts
/// `message_deleted`.
pub async fn delete_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((dm_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let mut tx = state.db.begin().await.map_err(internal_err)?;

    let deleted: Option<(Uuid,)> = sqlx::query_as(
        "DELETE FROM messages WHERE id = $1 AND dm_id = $2 AND sender_id = $3 RETURNING id",
    )
    .bind(message_id)
    .bind(dm_id)
    .bind(me)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal_err)?;

    if deleted.is_none() {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "not found, or you're not the sender" }))));
    }

    sqlx::query("DELETE FROM message_reactions WHERE message_id = $1 AND message_kind = 'dm'")
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;

    tx.commit().await.map_err(internal_err)?;

    let participants: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({ "type": "message_deleted", "dm_id": dm_id, "message_id": message_id })).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ReactBody {
    pub emoji: String,
}

const MAX_EMOJI_LEN: usize = 32;

/// `POST /dms/:dm_id/messages/:message_id/reactions` — toggles: if you've
/// already reacted with this emoji, removes it; otherwise adds it. Simpler
/// client contract than separate add/remove endpoints for a UI where every
/// reaction click is "toggle this emoji from me".
pub async fn toggle_reaction(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((dm_id, message_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ReactBody>,
) -> Result<Json<Vec<ReactionSummary>>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let emoji = body.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_LEN {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid emoji" }))));
    }

    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM message_reactions WHERE message_id = $1 AND message_kind = 'dm' AND user_id = $2 AND emoji = $3",
    )
    .bind(message_id)
    .bind(me)
    .bind(emoji)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    if let Some((id,)) = existing {
        sqlx::query("DELETE FROM message_reactions WHERE id = $1")
            .bind(id)
            .execute(&state.db)
            .await
            .map_err(internal_err)?;
    } else {
        sqlx::query(
            "INSERT INTO message_reactions (message_id, message_kind, user_id, emoji) VALUES ($1, 'dm', $2, $3)",
        )
        .bind(message_id)
        .bind(me)
        .bind(emoji)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;
    }

    let summary = reaction_summary(&state, message_id, me).await.map_err(internal_err)?;

    let participants: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
        .bind(dm_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "reaction_update", "dm_id": dm_id, "message_id": message_id, "reactions": &summary,
    })).await;

    Ok(Json(summary))
}

/// Shared by both dms.rs and guilds.rs — aggregates reaction rows for one
/// message into per-emoji counts plus whether `viewer_id` is among the
/// reactors, the shape both frontends actually want to render (not raw rows).
pub async fn reaction_summary(state: &AppState, message_id: Uuid, viewer_id: Uuid) -> Result<Vec<ReactionSummary>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT emoji, COUNT(*) AS count, bool_or(user_id = $2) AS reacted_by_me
        FROM message_reactions
        WHERE message_id = $1
        GROUP BY emoji
        ORDER BY MIN(created_at)
        "#,
    )
    .bind(message_id)
    .bind(viewer_id)
    .fetch_all(&state.db)
    .await
}

/// `POST /dms/:id/messages` — multipart form: `content` (text field, may
/// be empty only if `file` is present) and an optional `file` field for a
/// single attachment. Persists the message and pushes it over the
/// WebSocket hub to every participant's live connections (including the
/// sender's other tabs/devices). Attachment bytes are never included in
/// the WS payload or the JSON list response — only metadata — the client
/// fetches the actual bytes via GET .../attachment on demand.
pub async fn send_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(dm_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<MessageView>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_participant(&state, dm_id, me).await?;

    let mut content = String::new();
    let mut attachment: Option<(Vec<u8>, String, String)> = None; // (bytes, mime, filename)
    let mut reply_to_message_id: Option<Uuid> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("malformed upload: {e}") })))
    })? {
        match field.name() {
            Some("content") => {
                content = field.text().await.map_err(|e| {
                    (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("bad content field: {e}") })))
                })?;
            }
            Some("reply_to_message_id") => {
                let raw = field.text().await.unwrap_or_default();
                reply_to_message_id = Uuid::parse_str(raw.trim()).ok();
            }
            Some("file") => {
                let filename = field.file_name().unwrap_or("attachment").to_string();
                let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
                let data = field.bytes().await.map_err(|e| {
                    (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("failed reading upload: {e}") })))
                })?;
                if data.len() > MAX_ATTACHMENT_BYTES {
                    return Err((
                        StatusCode::PAYLOAD_TOO_LARGE,
                        Json(json!({ "error": "file too large — max 20MB" })),
                    ));
                }
                attachment = Some((data.to_vec(), mime, filename));
            }
            _ => {}
        }
    }

    let content = content.trim().to_string();
    if content.is_empty() && attachment.is_none() {
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

    let (att_bytes, att_mime, att_filename, att_size): (Option<Vec<u8>>, Option<String>, Option<String>, Option<i32>) =
        match attachment {
            Some((bytes, mime, filename)) => {
                let size = bytes.len() as i32;
                (Some(bytes), Some(mime), Some(filename), Some(size))
            }
            None => (None, None, None, None),
        };

    let row: MessageRow = sqlx::query_as(
        "INSERT INTO messages (dm_id, sender_id, content, reply_to_message_id, attachment_data, attachment_mime, attachment_filename, attachment_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, dm_id, sender_id, content, created_at, edited_at, reply_to_message_id, attachment_mime, attachment_filename, attachment_size",
    )
    .bind(dm_id)
    .bind(me)
    .bind(&content)
    .bind(reply_to_message_id)
    .bind(&att_bytes)
    .bind(&att_mime)
    .bind(&att_filename)
    .bind(att_size)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;
    let mut msg = MessageView::from(row);
    msg.reply_to = fetch_reply_preview(&state, msg.reply_to_message_id).await;

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

/// `GET /dms/:dm_id/messages/:message_id/attachment` — streams the raw
/// attachment bytes back. Gated behind participant membership (unlike
/// guild icons, DM attachments are private, so this can't be a bare
/// unauthenticated `<img src>` the way guild icons are — the frontend
/// fetches the bytes with fetch() + Authorization header and turns them
/// into a blob: URL for display).
pub async fn get_attachment(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((dm_id, message_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    let me = match local_user_id(&state, &claims.sub).await {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Err(e) = assert_participant(&state, dm_id, me).await {
        return e.into_response();
    }

    let row: Option<(Vec<u8>, String, String)> = match sqlx::query_as(
        "SELECT attachment_data, attachment_mime, attachment_filename FROM messages
         WHERE id = $1 AND dm_id = $2 AND attachment_data IS NOT NULL",
    )
    .bind(message_id)
    .bind(dm_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal_err(e).into_response(),
    };

    let Some((data, mime, filename)) = row else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "no attachment" }))).into_response();
    };

    let disposition = format!("inline; filename=\"{}\"", filename.replace('"', ""));
    (
        [
            (axum::http::header::CONTENT_TYPE, mime),
            (axum::http::header::CONTENT_DISPOSITION, disposition),
        ],
        data,
    )
        .into_response()
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
