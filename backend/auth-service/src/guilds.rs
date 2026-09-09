//! Guilds ("servers"), channels, roles, and invites — Discord-style
//! community layer. See migrations/0004_guilds.sql for the schema and the
//! full bitfield permission layout (mirrored in the PERM_* constants below).

use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::clerk::ClerkUser;
use crate::AppState;

// ---------------------------------------------------------------------
// Permission bits (see migrations/0004_guilds.sql for the authoritative
// doc comment on each bit).
// ---------------------------------------------------------------------
pub const PERM_VIEW_CHANNELS: i64 = 1;
pub const PERM_SEND_MESSAGES: i64 = 2;
pub const PERM_MANAGE_MESSAGES: i64 = 4;
pub const PERM_CONNECT: i64 = 8;
pub const PERM_SPEAK: i64 = 16;
pub const PERM_MANAGE_CHANNELS: i64 = 32;
pub const PERM_MANAGE_ROLES: i64 = 64;
pub const PERM_KICK_MEMBERS: i64 = 128;
pub const PERM_BAN_MEMBERS: i64 = 256;
pub const PERM_MANAGE_GUILD: i64 = 512;
pub const PERM_ADMINISTRATOR: i64 = 1_073_741_824;

type ApiError = (StatusCode, Json<Value>);

async fn local_user_id(state: &AppState, clerk_sub: &str) -> Result<Uuid, ApiError> {
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

fn internal_err(e: sqlx::Error) -> ApiError {
    tracing::error!("db error: {e:#}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal error" })),
    )
}

fn bad_request(msg: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })))
}

fn forbidden(msg: &str) -> ApiError {
    (StatusCode::FORBIDDEN, Json(json!({ "error": msg })))
}

fn not_found(msg: &str) -> ApiError {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg })))
}

/// Combined permission bits for `user_id` in `guild_id`: bit-OR of every
/// role they hold, plus the guild's `@everyone` (is_default) role which
/// every member implicitly has regardless of explicit assignment. Returns
/// 0 (not an error) if the guild doesn't exist or the user isn't a member
/// — callers layer the owner-bypass check on top of this since that's
/// cheaper to check first in most callers.
async fn combined_permission_bits(state: &AppState, guild_id: Uuid, user_id: Uuid) -> Result<i64, sqlx::Error> {
    let row: (Option<i64>,) = sqlx::query_as(
        "SELECT bit_or(permissions) FROM guild_roles
         WHERE guild_id = $1 AND (is_default = true OR id IN (
             SELECT role_id FROM guild_member_roles WHERE guild_id = $1 AND user_id = $2
         ))",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    Ok(row.0.unwrap_or(0))
}

/// The permission-check helper described in the task spec: owner bypasses
/// everything, ADMINISTRATOR bypasses everything, otherwise checks the
/// specific bit. Returns `Ok(false)` (not an error) for a non-member.
pub async fn has_permission(
    state: &AppState,
    guild_id: Uuid,
    user_id: Uuid,
    required_bit: i64,
) -> Result<bool, sqlx::Error> {
    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1")
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((owner_id,)) = owner else {
        return Ok(false);
    };
    if owner_id == user_id {
        return Ok(true);
    }

    let is_member: Option<(Uuid,)> =
        sqlx::query_as("SELECT guild_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(guild_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    if is_member.is_none() {
        return Ok(false);
    }

    let bits = combined_permission_bits(state, guild_id, user_id).await?;
    Ok(bits & PERM_ADMINISTRATOR != 0 || bits & required_bit != 0)
}

async fn require_permission(state: &AppState, guild_id: Uuid, user_id: Uuid, bit: i64) -> Result<(), ApiError> {
    if has_permission(state, guild_id, user_id, bit)
        .await
        .map_err(internal_err)?
    {
        Ok(())
    } else {
        Err(forbidden("you don't have the required permission for this action"))
    }
}

async fn assert_member(state: &AppState, guild_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT guild_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(guild_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;
    if row.is_none() {
        return Err(forbidden("not a member of this guild"));
    }
    Ok(())
}

/// Appends one row to guild_audit_log. Best-effort — a logging failure
/// must never block the actual moderation action it's describing, so
/// errors here are only logged to tracing, never propagated as an
/// ApiError. `target_label` is a human-readable snapshot (e.g. a
/// username or channel name) captured at action time, so the log still
/// reads sensibly even after the target itself is later renamed/deleted.
async fn log_audit(
    state: &AppState,
    guild_id: Uuid,
    actor_id: Uuid,
    action_type: &str,
    target_id: Option<Uuid>,
    target_label: Option<&str>,
    reason: Option<&str>,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO guild_audit_log (guild_id, actor_id, action_type, target_id, target_label, reason)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(guild_id)
    .bind(actor_id)
    .bind(action_type)
    .bind(target_id)
    .bind(target_label)
    .bind(reason)
    .execute(&state.db)
    .await
    {
        tracing::warn!("failed to write audit log entry ({action_type} in {guild_id}): {e:#}");
    }
}

/// Posts a real "X joined the server" system message into the guild's
/// configured system_channel_id, if one is set — mirrors Discord's
/// default join-message behavior. Best-effort: any failure here (no
/// system channel configured, insert error) is silently swallowed since
/// this is a nicety, never something that should block an actual join.
async fn post_join_system_message(state: &AppState, guild_id: Uuid, user_id: Uuid) {
    let system_channel: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT system_channel_id FROM guilds WHERE id = $1")
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
    let Some((Some(channel_id),)) = system_channel else {
        return;
    };

    let username: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT username, email FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
    let Some((uname, email)) = username else { return };
    let display = uname.unwrap_or(email);

    let row: Option<GuildMessageRow> = sqlx::query_as(
        "INSERT INTO guild_messages (channel_id, sender_id, content, is_system)
         VALUES ($1, $2, $3, true)
         RETURNING id, channel_id, sender_id, content, created_at, edited_at, pinned_at, is_system,
                   NULL::text AS attachment_mime, NULL::text AS attachment_filename, NULL::int AS attachment_size",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(format!("{display} joined the server."))
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);

    let Some(row) = row else { return };
    let msg = GuildMessageView::from(row);

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "guild_message", "guild_id": guild_id, "channel_id": channel_id, "message": &msg,
    })).await;
}

/// Force-disconnects `user_id` from any voice channel *belonging to this
/// guild* they're currently in, and notifies the remaining participants —
/// used when a member is kicked or leaves, so they don't keep transmitting
/// audio into a channel they're no longer allowed in and other members
/// don't see a ghost peer stuck in the roster. Only touches this guild's
/// channels (a user could theoretically be in a voice channel of a
/// *different* guild at the same time, which must be left untouched).
async fn force_disconnect_guild_voice(state: &AppState, guild_id: Uuid, user_id: Uuid) {
    let guild_channel_ids: Vec<(Uuid,)> = match sqlx::query_as(
        "SELECT id FROM guild_channels WHERE guild_id = $1 AND kind = 'voice'",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("force_disconnect_guild_voice: failed to list voice channels: {e}");
            return;
        }
    };

    for (channel_id,) in guild_channel_ids {
        if !state.ws_hub.is_in_voice_channel(channel_id, user_id).await {
            continue;
        }
        state.ws_hub.voice_leave(channel_id, user_id).await;
        let remaining = state.ws_hub.voice_members(channel_id).await;
        let left_payload = json!({
            "type": "voice_user_left",
            "channel_id": channel_id,
            "user_id": user_id,
        });
        state.ws_hub.send_to_many(&remaining, left_payload).await;
        // Tell the removed user's own client(s) too, so an open voice UI
        // tab tears itself down immediately instead of looking connected
        // while actually cut off server-side.
        let forced_payload = json!({
            "type": "voice_user_left",
            "channel_id": channel_id,
            "user_id": user_id,
        });
        state.ws_hub.send_to(user_id, forced_payload).await;
    }
}

// ---------------------------------------------------------------------
// View structs
// ---------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct GuildListItem {
    pub id: Uuid,
    pub name: String,
    pub icon_color: String,
    pub owner_id: Uuid,
    pub member_count: i64,
}

#[derive(Serialize, sqlx::FromRow, Clone)]
pub struct ChannelView {
    pub id: Uuid,
    pub guild_id: Uuid,
    pub category_id: Option<Uuid>,
    pub name: String,
    pub kind: String,
    pub position: i32,
    pub topic: Option<String>,
    pub slow_mode_seconds: i32,
    pub is_nsfw: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CategoryView {
    pub id: Uuid,
    pub guild_id: Uuid,
    pub name: String,
    pub position: i32,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct RoleView {
    pub id: Uuid,
    pub guild_id: Uuid,
    pub name: String,
    pub color: String,
    pub position: i32,
    pub permissions: i64,
    pub is_default: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct GuildMessageView {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub sender_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub pinned_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub is_system: bool,
    #[sqlx(skip)]
    pub attachment: Option<GuildAttachmentMeta>,
}

#[derive(Serialize)]
pub struct GuildAttachmentMeta {
    pub filename: String,
    pub mime: String,
    pub size: i32,
}

#[derive(sqlx::FromRow)]
struct GuildMessageRow {
    id: Uuid,
    channel_id: Uuid,
    sender_id: Uuid,
    content: String,
    created_at: DateTime<Utc>,
    edited_at: Option<DateTime<Utc>>,
    pinned_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    is_system: bool,
    attachment_mime: Option<String>,
    attachment_filename: Option<String>,
    attachment_size: Option<i32>,
}

impl From<GuildMessageRow> for GuildMessageView {
    fn from(r: GuildMessageRow) -> Self {
        let attachment = match (r.attachment_mime, r.attachment_filename, r.attachment_size) {
            (Some(mime), Some(filename), Some(size)) => Some(GuildAttachmentMeta { filename, mime, size }),
            _ => None,
        };
        GuildMessageView {
            id: r.id,
            channel_id: r.channel_id,
            sender_id: r.sender_id,
            content: r.content,
            created_at: r.created_at,
            edited_at: r.edited_at,
            pinned_at: r.pinned_at,
            is_system: r.is_system,
            attachment,
        }
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InviteView {
    pub code: String,
    pub guild_id: Uuid,
    pub created_by: Uuid,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateGuildBody {
    pub name: String,
}

/// The name/icon color for the auto-created default community server —
/// the one every new user is joined to automatically. Not user-editable
/// (MANAGE_GUILD still works on it like any guild, but nothing here
/// hardcodes it as immutable — an owner/admin can rename it same as any
/// server; this is just the seed values used the one time it's created).
const DEFAULT_COMMUNITY_NAME: &str = "NosChat Community";
const DEFAULT_COMMUNITY_ICON: &str = "#5FD9C4";

/// Same cap as dms::MAX_ATTACHMENT_BYTES (kept as a separate constant
/// since that one is private to dms.rs) — 20MB is generous for real
/// images/short clips/small documents while staying sane for inline
/// Postgres storage.
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

/// Idempotently returns the id of the single shared default-community
/// guild, creating it (with a starter category + a handful of text/voice
/// channels) the first time it's needed. Safe under concurrent callers:
/// the partial unique index on `is_default_community` means a race
/// between two simultaneous first-ever signups can only successfully
/// INSERT once — the loser's insert hits the unique constraint and this
/// function just re-queries to pick up the winner's row instead of
/// erroring.
///
/// `founding_user_id` becomes `owner_id` only if this call is the one
/// that actually creates the guild (i.e. whoever triggers creation, which
/// in practice is simply whichever new user signs up first ever). Every
/// other guild in the schema requires a real owner_id (NOT NULL FK), so a
/// "belongs to everyone" system guild still needs *a* nominal owner —
/// ownership carries no special end-user-visible meaning here since
/// MANAGE_GUILD is what actually gates administration, and staff (see
/// routes.rs's is_dev_staff_email) can always manage any guild regardless
/// of who nominally owns it.
async fn get_or_create_default_guild(state: &AppState, founding_user_id: Uuid) -> Result<Uuid, sqlx::Error> {
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT id FROM guilds WHERE is_default_community = true",
    )
    .fetch_optional(&state.db)
    .await?
    {
        return Ok(id);
    }

    let mut tx = state.db.begin().await?;

    let insert_result: Result<(Uuid,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO guilds (name, icon_color, owner_id, is_default_community)
         VALUES ($1, $2, $3, true) RETURNING id",
    )
    .bind(DEFAULT_COMMUNITY_NAME)
    .bind(DEFAULT_COMMUNITY_ICON)
    .bind(founding_user_id)
    .fetch_one(&mut *tx)
    .await;

    let guild_id = match insert_result {
        Ok((id,)) => id,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            // Lost the creation race to a concurrent signup — fine, just
            // read back whichever guild won.
            tx.rollback().await.ok();
            let (id,): (Uuid,) = sqlx::query_as(
                "SELECT id FROM guilds WHERE is_default_community = true",
            )
            .fetch_one(&state.db)
            .await?;
            return Ok(id);
        }
        Err(e) => return Err(e),
    };

    let default_perms = PERM_VIEW_CHANNELS | PERM_SEND_MESSAGES | PERM_CONNECT | PERM_SPEAK;
    sqlx::query(
        "INSERT INTO guild_roles (guild_id, name, position, permissions, is_default)
         VALUES ($1, '@everyone', 0, $2, true)",
    )
    .bind(guild_id)
    .bind(default_perms)
    .execute(&mut *tx)
    .await?;

    let (welcome_category_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO channel_categories (guild_id, name, position) VALUES ($1, 'WELCOME', 0) RETURNING id",
    )
    .bind(guild_id)
    .fetch_one(&mut *tx)
    .await?;

    let (community_category_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO channel_categories (guild_id, name, position) VALUES ($1, 'COMMUNITY', 1) RETURNING id",
    )
    .bind(guild_id)
    .fetch_one(&mut *tx)
    .await?;

    // A small real starter layout — not just one bare "general" channel,
    // so a brand new install feels like an actual populated community
    // from the very first signup instead of an empty room. Every
    // signed-up user lands here automatically (see auto_join_default_guild),
    // so this is the one guild guaranteed to always have members.
    let channels: &[(Uuid, &str, &str, i32)] = &[
        (welcome_category_id, "welcome", "text", 0),
        (welcome_category_id, "rules", "text", 1),
        (welcome_category_id, "announcements", "text", 2),
        (community_category_id, "general", "text", 0),
        (community_category_id, "off-topic", "text", 1),
        (community_category_id, "General Voice", "voice", 2),
        (community_category_id, "Music", "voice", 3),
    ];
    for (category_id, name, kind, position) in channels {
        sqlx::query(
            "INSERT INTO guild_channels (guild_id, category_id, name, kind, position) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(guild_id)
        .bind(category_id)
        .bind(name)
        .bind(kind)
        .bind(position)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(guild_id)
}

/// Joins `user_id` to the shared default-community guild if they aren't
/// already a member — called from routes.rs's get_or_create_local_user
/// the moment a brand new user row is created, so every real signup lands
/// in a populated server automatically instead of starting with an empty
/// friends list and no servers at all.
pub async fn auto_join_default_guild(state: &AppState, user_id: Uuid) -> Result<(), sqlx::Error> {
    let guild_id = get_or_create_default_guild(state, user_id).await?;

    let already_member: Option<(Uuid,)> =
        sqlx::query_as("SELECT guild_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(guild_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    if already_member.is_some() {
        return Ok(());
    }

    sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(guild_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;

    post_join_system_message(state, guild_id, user_id).await;

    let default_role: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM guild_roles WHERE guild_id = $1 AND is_default = true")
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((role_id,)) = default_role {
        sqlx::query(
            "INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(guild_id)
        .bind(user_id)
        .bind(role_id)
        .execute(&state.db)
        .await?;
    }

    Ok(())
}

/// Ensures `user_id` (the dev/staff account) owns the default community
/// guild and holds a role with full ADMINISTRATOR permissions there.
/// Called opportunistically whenever the dev-staff-email account is seen
/// (see routes.rs's get_or_create_local_user) so stealzers.com@gmail.com
/// always ends up as the real owner + admin of the one guild every user is
/// auto-joined to — self-healing the same way staff status does, no
/// manual DB fix needed if the guild was created before this account
/// existed or ownership drifted for any reason.
pub async fn ensure_default_community_owner(state: &AppState, user_id: Uuid) -> Result<(), sqlx::Error> {
    let guild_id = get_or_create_default_guild(state, user_id).await?;

    sqlx::query("UPDATE guilds SET owner_id = $1 WHERE id = $2 AND owner_id <> $1")
        .bind(user_id)
        .bind(guild_id)
        .execute(&state.db)
        .await?;

    // Make sure the owner is actually a member (should already be true via
    // auto_join_default_guild, but this call can run standalone too).
    sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(guild_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;

    // Give them (and only them, individually — not @everyone) a dedicated
    // "Admin" role with every permission bit set, on top of already being
    // guild owner (owner already bypasses permission checks everywhere via
    // the owner_id == user_id short-circuit in has_permission, but a
    // visible role is also what makes them show up distinctly in the
    // member list / role UI, matching how Discord server owners usually
    // also hold a colored admin role rather than relying purely on the
    // invisible owner bit).
    let admin_role: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM guild_roles WHERE guild_id = $1 AND name = 'Admin'",
    )
    .bind(guild_id)
    .fetch_optional(&state.db)
    .await?;

    let role_id = match admin_role {
        Some((id,)) => id,
        None => {
            let max_position: (Option<i32>,) =
                sqlx::query_as("SELECT MAX(position) FROM guild_roles WHERE guild_id = $1")
                    .bind(guild_id)
                    .fetch_one(&state.db)
                    .await?;
            let position = max_position.0.unwrap_or(0) + 1;
            let (id,): (Uuid,) = sqlx::query_as(
                "INSERT INTO guild_roles (guild_id, name, position, permissions, color, is_default)
                 VALUES ($1, 'Admin', $2, $3, '#F0A868', false) RETURNING id",
            )
            .bind(guild_id)
            .bind(position)
            .bind(PERM_ADMINISTRATOR)
            .fetch_one(&state.db)
            .await?;
            id
        }
    };

    sqlx::query(
        "INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(role_id)
    .execute(&state.db)
    .await?;

    Ok(())
}

/// `POST /guilds` — creates a guild, an `@everyone` role, a default
/// `general` text channel and `General` voice channel, and makes the
/// caller the owner + first member.
pub async fn create_guild(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Json(body): Json<CreateGuildBody>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("guild name can't be empty"));
    }

    let mut tx = state.db.begin().await.map_err(internal_err)?;

    let (guild_id, guild_name, icon_color, owner_id): (Uuid, String, String, Uuid) = sqlx::query_as(
        "INSERT INTO guilds (name, owner_id) VALUES ($1, $2) RETURNING id, name, icon_color, owner_id",
    )
    .bind(name)
    .bind(me)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_err)?;

    let default_perms = PERM_VIEW_CHANNELS | PERM_SEND_MESSAGES | PERM_CONNECT | PERM_SPEAK;
    let (role_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO guild_roles (guild_id, name, position, permissions, is_default)
         VALUES ($1, '@everyone', 0, $2, true) RETURNING id",
    )
    .bind(guild_id)
    .bind(default_perms)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_err)?;

    let text_channel: ChannelView = sqlx::query_as(
        "INSERT INTO guild_channels (guild_id, name, kind, position)
         VALUES ($1, 'general', 'text', 0)
         RETURNING id, guild_id, category_id, name, kind, position, topic",
    )
    .bind(guild_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_err)?;

    let voice_channel: ChannelView = sqlx::query_as(
        "INSERT INTO guild_channels (guild_id, name, kind, position)
         VALUES ($1, 'General', 'voice', 1)
         RETURNING id, guild_id, category_id, name, kind, position, topic",
    )
    .bind(guild_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_err)?;

    sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)")
        .bind(guild_id)
        .bind(me)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;

    sqlx::query("INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)")
        .bind(guild_id)
        .bind(me)
        .bind(role_id)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;

    tx.commit().await.map_err(internal_err)?;

    Ok(Json(json!({
        "id": guild_id,
        "name": guild_name,
        "icon_color": icon_color,
        "owner_id": owner_id,
        "channels": [text_channel, voice_channel],
    })))
}

/// `GET /guilds` — every guild the caller is a member of.
pub async fn list_guilds(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Vec<GuildListItem>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;

    let rows: Vec<GuildListItem> = sqlx::query_as(
        r#"
        SELECT
            g.id, g.name, g.icon_color, g.owner_id,
            (SELECT COUNT(*) FROM guild_members gm2 WHERE gm2.guild_id = g.id) AS member_count
        FROM guilds g
        JOIN guild_members gm ON gm.guild_id = g.id AND gm.user_id = $1
        ORDER BY g.name
        "#,
    )
    .bind(me)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}

/// `GET /guilds/:id` — guild detail: identity, your computed permission
/// bits, your roles, and the full channel/category layout.
pub async fn get_guild(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;

    let guild: Option<(Uuid, String, String, Uuid, i16, Option<String>, Option<Uuid>)> =
        sqlx::query_as("SELECT id, name, icon_color, owner_id, verification_level, description, system_channel_id FROM guilds WHERE id = $1")
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;
    let Some((id, name, icon_color, owner_id, verification_level, description, system_channel_id)) = guild else {
        return Err(not_found("guild not found"));
    };

    let categories: Vec<CategoryView> = sqlx::query_as(
        "SELECT id, guild_id, name, position FROM channel_categories WHERE guild_id = $1 ORDER BY position",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let channels: Vec<ChannelView> = sqlx::query_as(
        "SELECT id, guild_id, category_id, name, kind, position, topic, slow_mode_seconds, is_nsfw FROM guild_channels WHERE guild_id = $1 ORDER BY position",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let my_roles: Vec<RoleView> = sqlx::query_as(
        r#"
        SELECT r.id, r.guild_id, r.name, r.color, r.position, r.permissions, r.is_default
        FROM guild_roles r
        WHERE r.guild_id = $1 AND (r.is_default = true OR r.id IN (
            SELECT role_id FROM guild_member_roles WHERE guild_id = $1 AND user_id = $2
        ))
        ORDER BY r.position DESC
        "#,
    )
    .bind(guild_id)
    .bind(me)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let mut bits = combined_permission_bits(&state, guild_id, me).await.map_err(internal_err)?;
    if owner_id == me {
        bits |= PERM_ADMINISTRATOR;
    }

    Ok(Json(json!({
        "id": id,
        "name": name,
        "icon_color": icon_color,
        "owner_id": owner_id,
        "verification_level": verification_level,
        "description": description,
        "system_channel_id": system_channel_id,
        "my_permissions": bits,
        "my_roles": my_roles,
        "categories": categories,
        "channels": channels,
    })))
}

#[derive(Deserialize)]
pub struct UpdateGuildBody {
    pub name: Option<String>,
    pub icon_color: Option<String>,
    pub verification_level: Option<i16>,
    pub description: Option<String>,
    pub system_channel_id: Option<Uuid>,
}

/// `PATCH /guilds/:id` — requires MANAGE_GUILD.
pub async fn update_guild(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    Json(body): Json<UpdateGuildBody>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_GUILD).await?;

    if let Some(lvl) = body.verification_level {
        if !(0..=1).contains(&lvl) {
            return Err(bad_request("verification_level must be 0 or 1"));
        }
    }

    let description = body.description.as_deref().map(|d| {
        d.chars().take(1024).collect::<String>()
    });

    let row: Option<(Uuid, String, String, i16, Option<String>, Option<Uuid>)> = sqlx::query_as(
        "UPDATE guilds SET name = COALESCE($2, name), icon_color = COALESCE($3, icon_color),
             verification_level = COALESCE($4, verification_level),
             description = COALESCE($5, description),
             system_channel_id = COALESCE($6, system_channel_id),
             updated_at = now()
         WHERE id = $1 RETURNING id, name, icon_color, verification_level, description, system_channel_id",
    )
    .bind(guild_id)
    .bind(body.name)
    .bind(body.icon_color)
    .bind(body.verification_level)
    .bind(description)
    .bind(body.system_channel_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some((id, name, icon_color, verification_level, description, system_channel_id)) = row else {
        return Err(not_found("guild not found"));
    };

    Ok(Json(json!({
        "id": id, "name": name, "icon_color": icon_color,
        "verification_level": verification_level, "description": description,
        "system_channel_id": system_channel_id,
    })))
}

const MAX_ICON_BYTES: usize = 2 * 1024 * 1024; // 2MB — same inline-in-Postgres cap as sounds.rs

/// `POST /guilds/:id/icon` — multipart image upload, requires MANAGE_GUILD.
/// Stored inline in Postgres (icon_image/icon_image_mime), same pattern as
/// user_sound_settings' custom clip upload — no object storage service
/// exists yet. Setting an image doesn't clear icon_color (it stays as the
/// fallback if the image is ever removed via DELETE).
pub async fn upload_guild_icon(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_GUILD).await?;

    let mut bytes: Option<Vec<u8>> = None;
    let mut mime = "image/png".to_string();

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        bad_request(&format!("malformed upload: {e}"))
    })? {
        if field.name() == Some("file") {
            if let Some(ct) = field.content_type() {
                mime = ct.to_string();
            }
            let data = field.bytes().await.map_err(|e| bad_request(&format!("failed reading upload: {e}")))?;
            if data.len() > MAX_ICON_BYTES {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(json!({ "error": "image too large — max 2MB" })),
                ));
            }
            if !mime.starts_with("image/") {
                return Err(bad_request("file must be an image"));
            }
            bytes = Some(data.to_vec());
        }
    }

    let Some(bytes) = bytes else {
        return Err(bad_request("missing 'file' field"));
    };

    sqlx::query("UPDATE guilds SET icon_image = $1, icon_image_mime = $2, updated_at = now() WHERE id = $3")
        .bind(&bytes)
        .bind(&mime)
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(Json(json!({ "status": "ok" })))
}

/// `DELETE /guilds/:id/icon` — reverts to the color-swatch icon.
pub async fn delete_guild_icon(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_GUILD).await?;

    sqlx::query("UPDATE guilds SET icon_image = NULL, icon_image_mime = NULL, updated_at = now() WHERE id = $1")
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /guilds/:id/icon` — streams the raw image back. Deliberately NOT
/// gated behind ClerkUser/membership: like Discord, a guild icon needs to
/// be fetchable as a plain `<img src>` (no way to attach an Authorization
/// header to an img tag), and it's not sensitive data. 404s if no image is
/// set (frontend falls back to the color swatch in that case).
pub async fn get_guild_icon(
    State(state): State<AppState>,
    Path(guild_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let row: Option<(Option<Vec<u8>>, Option<String>)> =
        sqlx::query_as("SELECT icon_image, icon_image_mime FROM guilds WHERE id = $1")
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;

    let Some((Some(bytes), mime)) = row else {
        return Err(not_found("no icon image set for this guild"));
    };

    let mime = mime.unwrap_or_else(|| "image/png".to_string());
    Ok(([(header::CONTENT_TYPE, mime)], bytes))
}

/// `DELETE /guilds/:id` — owner only, not just MANAGE_GUILD.
pub async fn delete_guild(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;

    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1")
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    let Some((owner_id,)) = owner else {
        return Err(not_found("guild not found"));
    };
    if owner_id != me {
        return Err(forbidden("only the guild owner can delete it"));
    }

    sqlx::query("DELETE FROM guilds WHERE id = $1")
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(StatusCode::NO_CONTENT)
}

/// `POST /guilds/:id/leave` — owner cannot leave (must delete instead).
pub async fn leave_guild(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;

    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1")
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    let Some((owner_id,)) = owner else {
        return Err(not_found("guild not found"));
    };
    if owner_id == me {
        return Err(bad_request(
            "the owner can't leave — delete the guild instead (ownership transfer isn't supported yet)",
        ));
    }

    sqlx::query("DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2")
        .bind(guild_id)
        .bind(me)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    force_disconnect_guild_voice(&state, guild_id, me).await;

    Ok(Json(json!({ "status": "left" })))
}

/// `GET /guilds/:id/members`
pub async fn list_members(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;

    let members: Vec<(Uuid, Option<String>, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT u.id, u.username, u.email, gm.nickname, u.is_staff
         FROM guild_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.guild_id = $1 ORDER BY u.username",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let role_rows: Vec<(Uuid, Uuid, String, String)> = sqlx::query_as(
        "SELECT gmr.user_id, r.id, r.name, r.color
         FROM guild_member_roles gmr JOIN guild_roles r ON r.id = gmr.role_id
         WHERE gmr.guild_id = $1
         ORDER BY r.position DESC",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    let mut roles_by_user: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for (user_id, role_id, role_name, role_color) in role_rows {
        roles_by_user
            .entry(user_id)
            .or_default()
            .push(json!({ "id": role_id, "name": role_name, "color": role_color }));
    }

    let result: Vec<Value> = members
        .into_iter()
        .map(|(user_id, username, email, nickname, is_staff)| {
            json!({
                "user_id": user_id,
                "username": username,
                "email": email,
                "nickname": nickname,
                "is_staff": is_staff,
                "roles": roles_by_user.get(&user_id).cloned().unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(result))
}

/// `DELETE /guilds/:id/members/:user_id` — kick, requires KICK_MEMBERS.
pub async fn kick_member(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_KICK_MEMBERS).await?;

    if user_id == me {
        return Err(bad_request("use /leave to remove yourself"));
    }

    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1")
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    if let Some((owner_id,)) = owner {
        if owner_id == user_id {
            return Err(forbidden("can't kick the guild owner"));
        }
    }

    sqlx::query("DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2")
        .bind(guild_id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    force_disconnect_guild_voice(&state, guild_id, user_id).await;

    let target_label: Option<(Option<String>,)> = sqlx::query_as("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);
    log_audit(
        &state, guild_id, me, "member_kick", Some(user_id),
        target_label.and_then(|(u,)| u).as_deref(), None,
    ).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub struct BanMemberBody {
    pub reason: Option<String>,
}

const MAX_BAN_REASON_LEN: usize = 512;

/// `PUT /guilds/:id/bans/:user_id` — bans by user id (works even if they
/// were never a member, matching Discord). Removes any existing
/// membership too, so an existing member is both kicked and banned in one
/// step. Requires BAN_MEMBERS; owner can't be banned.
pub async fn ban_member(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, user_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<BanMemberBody>>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_BAN_MEMBERS).await?;

    if user_id == me {
        return Err(bad_request("you can't ban yourself"));
    }

    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT owner_id FROM guilds WHERE id = $1")
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    let Some((owner_id,)) = owner else {
        return Err(not_found("guild not found"));
    };
    if owner_id == user_id {
        return Err(forbidden("can't ban the guild owner"));
    }

    let reason = body.and_then(|b| b.0.reason).map(|r| {
        r.chars().take(MAX_BAN_REASON_LEN).collect::<String>()
    });

    let mut tx = state.db.begin().await.map_err(internal_err)?;

    sqlx::query("DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2")
        .bind(guild_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;

    sqlx::query(
        "INSERT INTO guild_bans (guild_id, user_id, banned_by, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET banned_by = $3, reason = $4, created_at = now()",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(me)
    .bind(&reason)
    .execute(&mut *tx)
    .await
    .map_err(internal_err)?;

    tx.commit().await.map_err(internal_err)?;

    force_disconnect_guild_voice(&state, guild_id, user_id).await;

    // Tell the banned user's own client(s), so an open guild UI tab can
    // navigate away immediately instead of looking accessible while
    // actually cut off server-side.
    state.ws_hub.send_to(user_id, json!({
        "type": "guild_banned", "guild_id": guild_id,
    })).await;

    let target_label: Option<(Option<String>,)> = sqlx::query_as("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);
    log_audit(
        &state, guild_id, me, "member_ban", Some(user_id),
        target_label.and_then(|(u,)| u).as_deref(), reason.as_deref(),
    ).await;

    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /guilds/:id/bans/:user_id` — lifts a ban, doesn't re-add
/// membership (they need a fresh invite, matching Discord).
pub async fn unban_member(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_BAN_MEMBERS).await?;

    sqlx::query("DELETE FROM guild_bans WHERE guild_id = $1 AND user_id = $2")
        .bind(guild_id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    let target_label: Option<(Option<String>,)> = sqlx::query_as("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);
    log_audit(
        &state, guild_id, me, "member_unban", Some(user_id),
        target_label.and_then(|(u,)| u).as_deref(), None,
    ).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct BanView {
    pub user_id: Uuid,
    pub username: Option<String>,
    pub banned_by: Uuid,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// `GET /guilds/:id/bans` — requires BAN_MEMBERS (this is moderator-only
/// info, unlike the member list which any member can see).
pub async fn list_bans(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Vec<BanView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_BAN_MEMBERS).await?;

    let rows: Vec<BanView> = sqlx::query_as(
        r#"
        SELECT b.user_id, u.username, b.banned_by, b.reason, b.created_at
        FROM guild_bans b
        JOIN users u ON u.id = b.user_id
        WHERE b.guild_id = $1
        ORDER BY b.created_at DESC
        "#,
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditLogEntryView {
    pub id: Uuid,
    pub actor_id: Option<Uuid>,
    pub actor_username: Option<String>,
    pub action_type: String,
    pub target_id: Option<Uuid>,
    pub target_label: Option<String>,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// `GET /guilds/:id/audit-log` — requires ADMINISTRATOR (this is
/// deliberately more restrictive than BAN_MEMBERS/KICK_MEMBERS individually
/// since the log surfaces the full moderation history at once, matching
/// Discord's own "Audit Log" tab gating). Capped at the most recent 200
/// entries — this is a review tool, not an export/compliance feature.
pub async fn list_audit_log(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Vec<AuditLogEntryView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_ADMINISTRATOR).await?;

    let rows: Vec<AuditLogEntryView> = sqlx::query_as(
        r#"
        SELECT l.id, l.actor_id, u.username AS actor_username, l.action_type,
               l.target_id, l.target_label, l.reason, l.created_at
        FROM guild_audit_log l
        LEFT JOIN users u ON u.id = l.actor_id
        WHERE l.guild_id = $1
        ORDER BY l.created_at DESC
        LIMIT 200
        "#,
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}



#[derive(Deserialize)]
pub struct CreateChannelBody {
    pub name: String,
    pub kind: String,
    pub category_id: Option<Uuid>,
}

/// `POST /guilds/:id/channels` — requires MANAGE_CHANNELS.
pub async fn create_channel(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    Json(body): Json<CreateChannelBody>,
) -> Result<Json<ChannelView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_CHANNELS).await?;

    if body.kind != "text" && body.kind != "voice" {
        return Err(bad_request("kind must be 'text' or 'voice'"));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("channel name can't be empty"));
    }

    let (max_pos,): (Option<i32>,) = sqlx::query_as("SELECT MAX(position) FROM guild_channels WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let position = max_pos.unwrap_or(-1) + 1;

    let channel: ChannelView = sqlx::query_as(
        "INSERT INTO guild_channels (guild_id, category_id, name, kind, position)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, guild_id, category_id, name, kind, position, topic, slow_mode_seconds, is_nsfw",
    )
    .bind(guild_id)
    .bind(body.category_id)
    .bind(name)
    .bind(&body.kind)
    .bind(position)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(channel))
}

#[derive(Deserialize)]
pub struct UpdateChannelBody {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: Option<i32>,
    pub category_id: Option<Uuid>,
    pub slow_mode_seconds: Option<i32>,
    pub is_nsfw: Option<bool>,
}

/// `PATCH /guilds/:id/channels/:channel_id` — requires MANAGE_CHANNELS.
///
/// Deviation note: `category_id` uses a plain `Option<Uuid>`, so this
/// endpoint can't distinguish "field omitted, leave unchanged" from
/// "explicitly set to null, clear the category" — both currently mean
/// "leave unchanged" since COALESCE treats JSON null the same as an
/// absent key once deserialized. Clearing a channel's category needs a
/// small follow-up (an `Option<Option<Uuid>>` wrapper) if that UX is
/// needed; out of scope for this pass.
pub async fn update_channel(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateChannelBody>,
) -> Result<Json<ChannelView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_CHANNELS).await?;

    if let Some(secs) = body.slow_mode_seconds {
        if !(0..=21600).contains(&secs) {
            return Err(bad_request("slow_mode_seconds must be between 0 and 21600 (6 hours)"));
        }
    }

    let channel: Option<ChannelView> = sqlx::query_as(
        "UPDATE guild_channels SET
            name = COALESCE($3, name),
            topic = COALESCE($4, topic),
            position = COALESCE($5, position),
            category_id = COALESCE($6, category_id),
            slow_mode_seconds = COALESCE($7, slow_mode_seconds),
            is_nsfw = COALESCE($8, is_nsfw)
         WHERE id = $1 AND guild_id = $2
         RETURNING id, guild_id, category_id, name, kind, position, topic, slow_mode_seconds, is_nsfw",
    )
    .bind(channel_id)
    .bind(guild_id)
    .bind(body.name)
    .bind(body.topic)
    .bind(body.position)
    .bind(body.category_id)
    .bind(body.slow_mode_seconds)
    .bind(body.is_nsfw)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    channel.map(Json).ok_or_else(|| not_found("channel not found in this guild"))
}

/// `DELETE /guilds/:id/channels/:channel_id` — requires MANAGE_CHANNELS.
pub async fn delete_channel(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_CHANNELS).await?;

    let channel_name: Option<(String,)> = sqlx::query_as("SELECT name FROM guild_channels WHERE id = $1 AND guild_id = $2")
        .bind(channel_id)
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);

    sqlx::query("DELETE FROM guild_channels WHERE id = $1 AND guild_id = $2")
        .bind(channel_id)
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    log_audit(
        &state, guild_id, me, "channel_delete", Some(channel_id),
        channel_name.map(|(n,)| n).as_deref(), None,
    ).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct CreateCategoryBody {
    pub name: String,
}

/// `POST /guilds/:id/categories` — requires MANAGE_CHANNELS.
pub async fn create_category(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    Json(body): Json<CreateCategoryBody>,
) -> Result<Json<CategoryView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_CHANNELS).await?;

    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("category name can't be empty"));
    }

    let (max_pos,): (Option<i32>,) =
        sqlx::query_as("SELECT MAX(position) FROM channel_categories WHERE guild_id = $1")
            .bind(guild_id)
            .fetch_one(&state.db)
            .await
            .map_err(internal_err)?;
    let position = max_pos.unwrap_or(-1) + 1;

    let category: CategoryView = sqlx::query_as(
        "INSERT INTO channel_categories (guild_id, name, position) VALUES ($1, $2, $3)
         RETURNING id, guild_id, name, position",
    )
    .bind(guild_id)
    .bind(name)
    .bind(position)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(category))
}

// ---------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------

async fn assert_text_channel(state: &AppState, guild_id: Uuid, channel_id: Uuid) -> Result<(), ApiError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT kind FROM guild_channels WHERE id = $1 AND guild_id = $2")
            .bind(channel_id)
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;
    match row {
        Some((kind,)) if kind == "text" => Ok(()),
        Some(_) => Err(bad_request("that channel isn't a text channel")),
        None => Err(not_found("channel not found in this guild")),
    }
}

/// `GET /guilds/:id/channels/:channel_id/messages` — most recent 50,
/// oldest first. Requires VIEW_CHANNELS.
pub async fn list_channel_messages(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Vec<GuildMessageView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_VIEW_CHANNELS).await?;
    assert_text_channel(&state, guild_id, channel_id).await?;

    let rows: Vec<GuildMessageRow> = sqlx::query_as(
        r#"
        SELECT * FROM (
            SELECT id, channel_id, sender_id, content, created_at, edited_at, pinned_at,
                   attachment_mime, attachment_filename, attachment_size
            FROM guild_messages WHERE channel_id = $1
            ORDER BY created_at DESC LIMIT 50
        ) recent ORDER BY created_at ASC
        "#,
    )
    .bind(channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows.into_iter().map(GuildMessageView::from).collect()))
}

#[derive(Deserialize)]
pub struct SearchMessagesQuery {
    pub q: String,
    pub channel_id: Option<Uuid>,
}

/// `GET /guilds/:id/messages/search?q=...&channel_id=...` — full-text-ish
/// search (simple ILIKE, no tsvector index — this app's message volume
/// doesn't warrant one yet) across every text channel in the guild the
/// caller can actually view. Optional channel_id narrows to one channel.
/// Capped at 50 results, newest first, matching list_channel_messages'
/// existing cap.
pub async fn search_guild_messages(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<SearchMessagesQuery>,
) -> Result<Json<Vec<GuildMessageView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_VIEW_CHANNELS).await?;

    let term = q.q.trim();
    if term.is_empty() {
        return Ok(Json(vec![]));
    }
    let pattern = format!("%{}%", term.replace('%', "\\%").replace('_', "\\_"));

    let rows: Vec<GuildMessageRow> = if let Some(channel_id) = q.channel_id {
        assert_text_channel(&state, guild_id, channel_id).await?;
        sqlx::query_as(
            r#"
            SELECT id, channel_id, sender_id, content, created_at, edited_at, pinned_at,
                   attachment_mime, attachment_filename, attachment_size
            FROM guild_messages
            WHERE channel_id = $1 AND content ILIKE $2
            ORDER BY created_at DESC LIMIT 50
            "#,
        )
        .bind(channel_id)
        .bind(&pattern)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?
    } else {
        sqlx::query_as(
            r#"
            SELECT gm.id, gm.channel_id, gm.sender_id, gm.content, gm.created_at, gm.edited_at, gm.pinned_at,
                   gm.attachment_mime, gm.attachment_filename, gm.attachment_size
            FROM guild_messages gm
            JOIN guild_channels gc ON gc.id = gm.channel_id
            WHERE gc.guild_id = $1 AND gm.content ILIKE $2
            ORDER BY gm.created_at DESC LIMIT 50
            "#,
        )
        .bind(guild_id)
        .bind(&pattern)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?
    };

    Ok(Json(rows.into_iter().map(GuildMessageView::from).collect()))
}

/// `content` text field (may be empty only if `file` is present) plus an
/// optional `file` field. Persists then fans out to every online guild
/// member over the WS hub. Requires SEND_MESSAGES.
pub async fn send_channel_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id)): Path<(Uuid, Uuid)>,
    mut multipart: Multipart,
) -> Result<Json<GuildMessageView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_SEND_MESSAGES).await?;
    assert_text_channel(&state, guild_id, channel_id).await?;

    // Verification level enforcement — real server-side gate (Discord's
    // "must be a member for X" tier), not just a client-side hint.
    // Moderators (MANAGE_MESSAGES) bypass it, same rationale as slow mode.
    let (verification_level,): (i16,) = sqlx::query_as("SELECT verification_level FROM guilds WHERE id = $1")
        .bind(guild_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    if verification_level >= 1 && !has_permission(&state, guild_id, me, PERM_MANAGE_MESSAGES).await.unwrap_or(false) {
        let (created_at,): (chrono::DateTime<Utc>,) = sqlx::query_as("SELECT created_at FROM users WHERE id = $1")
            .bind(me)
            .fetch_one(&state.db)
            .await
            .map_err(internal_err)?;
        let account_age_secs = (Utc::now() - created_at).num_seconds();
        const MIN_ACCOUNT_AGE_SECS: i64 = 10 * 60; // 10 minutes, matching Discord's "Low" tier
        if account_age_secs < MIN_ACCOUNT_AGE_SECS {
            return Err(forbidden(
                "this server requires your account to be at least 10 minutes old to send messages",
            ));
        }
    }

    // Slow mode enforcement — real server-side rate limit, not just a UI
    // hint. Members with MANAGE_MESSAGES bypass it (matches Discord: mods
    // aren't rate-limited by a slow mode they can turn off anyway).
    let (slow_mode_seconds,): (i32,) = sqlx::query_as(
        "SELECT slow_mode_seconds FROM guild_channels WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;
    if slow_mode_seconds > 0 && !has_permission(&state, guild_id, me, PERM_MANAGE_MESSAGES).await.unwrap_or(false) {
        let last_sent: Option<(chrono::DateTime<Utc>,)> = sqlx::query_as(
            "SELECT created_at FROM guild_messages
             WHERE channel_id = $1 AND sender_id = $2
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(channel_id)
        .bind(me)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
        if let Some((last_at,)) = last_sent {
            let elapsed = (Utc::now() - last_at).num_seconds();
            let remaining = slow_mode_seconds as i64 - elapsed;
            if remaining > 0 {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({ "error": format!("slow mode: wait {remaining}s before sending again"), "retry_after": remaining })),
                ));
            }
        }
    }

    let mut content = String::new();
    let mut attachment: Option<(Vec<u8>, String, String)> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| bad_request(&format!("malformed upload: {e}")))? {
        match field.name() {
            Some("content") => {
                content = field.text().await.map_err(|e| bad_request(&format!("bad content field: {e}")))?;
            }
            Some("file") => {
                let filename = field.file_name().unwrap_or("attachment").to_string();
                let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
                let data = field.bytes().await.map_err(|e| bad_request(&format!("failed reading upload: {e}")))?;
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
        return Err(bad_request("message can't be empty"));
    }
    if content.chars().count() > 4000 {
        return Err(bad_request("message too long (max 4000 characters)"));
    }

    let (att_bytes, att_mime, att_filename, att_size): (Option<Vec<u8>>, Option<String>, Option<String>, Option<i32>) =
        match attachment {
            Some((bytes, mime, filename)) => {
                let size = bytes.len() as i32;
                (Some(bytes), Some(mime), Some(filename), Some(size))
            }
            None => (None, None, None, None),
        };

    let row: GuildMessageRow = sqlx::query_as(
        "INSERT INTO guild_messages (channel_id, sender_id, content, attachment_data, attachment_mime, attachment_filename, attachment_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, channel_id, sender_id, content, created_at, edited_at, pinned_at, attachment_mime, attachment_filename, attachment_size",
    )
    .bind(channel_id)
    .bind(me)
    .bind(&content)
    .bind(&att_bytes)
    .bind(&att_mime)
    .bind(&att_filename)
    .bind(att_size)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;
    let msg = GuildMessageView::from(row);

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();

    let payload = json!({
        "type": "guild_message",
        "guild_id": guild_id,
        "channel_id": channel_id,
        "message": &msg,
    });
    state.ws_hub.send_to_many(&recipient_ids, payload).await;

    // The sender has, by definition, "read" their own message — advance
    // their own read pointer too, same reasoning as dms::send_message.
    sqlx::query(
        "INSERT INTO guild_channel_reads (channel_id, user_id, last_read_message_id, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_message_id = $3, updated_at = now()",
    )
    .bind(channel_id)
    .bind(me)
    .bind(msg.id)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(msg))
}

/// `GET /guilds/:id/channels/:channel_id/messages/:message_id/attachment`
/// — streams the raw attachment bytes back. Gated behind guild membership
/// (VIEW_CHANNELS), same reasoning as dms::get_attachment: not a bare
/// unauthenticated `<img src>` like guild icons, since channel content can
/// be private to members.
pub async fn get_channel_attachment(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<impl IntoResponse, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_VIEW_CHANNELS).await?;

    let row: Option<(Vec<u8>, String, String)> = sqlx::query_as(
        "SELECT attachment_data, attachment_mime, attachment_filename FROM guild_messages
         WHERE id = $1 AND channel_id = $2 AND attachment_data IS NOT NULL",
    )
    .bind(message_id)
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some((data, mime, filename)) = row else {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "no attachment" }))));
    };

    let disposition = format!("inline; filename=\"{}\"", filename.replace('"', ""));
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, mime),
            (axum::http::header::CONTENT_DISPOSITION, disposition),
        ],
        data,
    ))
}

/// `POST /guilds/:id/channels/:channel_id/read` — marks the channel as
/// read up to its latest message for the caller. Mirrors dms::mark_read.
pub async fn mark_channel_read(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;
    assert_text_channel(&state, guild_id, channel_id).await?;

    let latest: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM guild_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;

    if let Some((last_id,)) = latest {
        sqlx::query(
            "INSERT INTO guild_channel_reads (channel_id, user_id, last_read_message_id, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_message_id = $3, updated_at = now()",
        )
        .bind(channel_id)
        .bind(me)
        .bind(last_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;
    }

    Ok(Json(json!({ "status": "ok" })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ChannelUnread {
    pub channel_id: Uuid,
    pub unread_count: i64,
}

/// `GET /guilds/:id/unread` — per-text-channel unread counts for the
/// caller, powering the guild-rail's unread ping dot and the channel
/// sidebar's per-channel unread indicator. Only counts messages sent by
/// *other* users (mirrors dms::list_dms' unread lateral join), and only
/// over channels the caller can actually VIEW.
pub async fn list_unread(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Vec<ChannelUnread>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;

    let rows: Vec<ChannelUnread> = sqlx::query_as(
        r#"
        SELECT c.id AS channel_id, COUNT(m.id) AS unread_count
        FROM guild_channels c
        LEFT JOIN guild_channel_reads r ON r.channel_id = c.id AND r.user_id = $2
        LEFT JOIN guild_messages m ON m.channel_id = c.id
            AND m.sender_id <> $2
            AND (
                r.last_read_message_id IS NULL
                OR m.created_at > (SELECT created_at FROM guild_messages WHERE id = r.last_read_message_id)
            )
        WHERE c.guild_id = $1 AND c.kind = 'text'
        GROUP BY c.id
        HAVING COUNT(m.id) > 0
        "#,
    )
    .bind(guild_id)
    .bind(me)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct EditGuildMessageBody {
    pub content: String,
}

/// `PATCH /guilds/:id/channels/:channel_id/messages/:message_id` — only
/// the original sender may edit (no permission bypasses editing someone
/// else's words, unlike delete).
pub async fn edit_channel_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<EditGuildMessageBody>,
) -> Result<Json<GuildMessageView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;

    let content = body.content.trim();
    if content.is_empty() {
        return Err(bad_request("message can't be empty"));
    }
    if content.chars().count() > 4000 {
        return Err(bad_request("message too long (max 4000 characters)"));
    }

    let row: Option<GuildMessageView> = sqlx::query_as(
        "UPDATE guild_messages SET content = $3, edited_at = now()
         WHERE id = $1 AND channel_id = $2 AND sender_id = $4
         RETURNING id, channel_id, sender_id, content, created_at, edited_at, pinned_at",
    )
    .bind(message_id)
    .bind(channel_id)
    .bind(content)
    .bind(me)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some(msg) = row else {
        return Err(forbidden("not found, or you're not the sender"));
    };

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "guild_message_edited", "guild_id": guild_id, "channel_id": channel_id, "message": &msg,
    })).await;

    Ok(Json(msg))
}

/// `POST /guilds/:id/channels/:channel_id/messages/:message_id/pin` — pins
/// a message to the channel's Pinned Messages panel. Requires
/// MANAGE_MESSAGES, matching Discord (pinning is a moderation action, not
/// something every member can do to any message).
pub async fn pin_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<GuildMessageView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_MESSAGES).await?;
    assert_text_channel(&state, guild_id, channel_id).await?;

    let row: Option<GuildMessageView> = sqlx::query_as(
        "UPDATE guild_messages SET pinned_at = now(), pinned_by = $3
         WHERE id = $1 AND channel_id = $2
         RETURNING id, channel_id, sender_id, content, created_at, edited_at, pinned_at",
    )
    .bind(message_id)
    .bind(channel_id)
    .bind(me)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some(msg) = row else {
        return Err(not_found("message not found"));
    };

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "guild_message_pinned", "guild_id": guild_id, "channel_id": channel_id, "message": &msg,
    })).await;

    Ok(Json(msg))
}

/// `DELETE /guilds/:id/channels/:channel_id/messages/:message_id/pin` —
/// unpins a message. Same MANAGE_MESSAGES gate as pinning.
pub async fn unpin_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<GuildMessageView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_MESSAGES).await?;
    assert_text_channel(&state, guild_id, channel_id).await?;

    let row: Option<GuildMessageView> = sqlx::query_as(
        "UPDATE guild_messages SET pinned_at = NULL, pinned_by = NULL
         WHERE id = $1 AND channel_id = $2
         RETURNING id, channel_id, sender_id, content, created_at, edited_at, pinned_at",
    )
    .bind(message_id)
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some(msg) = row else {
        return Err(not_found("message not found"));
    };

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "guild_message_unpinned", "guild_id": guild_id, "channel_id": channel_id, "message": &msg,
    })).await;

    Ok(Json(msg))
}

/// `GET /guilds/:id/channels/:channel_id/pins` — lists every currently
/// pinned message in the channel, newest pin first (matches Discord's
/// Pinned Messages panel ordering).
pub async fn list_pinned_messages(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Vec<GuildMessageView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_VIEW_CHANNELS).await?;
    assert_text_channel(&state, guild_id, channel_id).await?;

    let rows: Vec<GuildMessageRow> = sqlx::query_as(
        "SELECT id, channel_id, sender_id, content, created_at, edited_at, pinned_at,
                attachment_mime, attachment_filename, attachment_size
         FROM guild_messages
         WHERE channel_id = $1 AND pinned_at IS NOT NULL
         ORDER BY pinned_at DESC",
    )
    .bind(channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows.into_iter().map(GuildMessageView::from).collect()))
}


/// `DELETE /guilds/:id/channels/:channel_id/messages/:message_id` — the
/// sender can always delete their own message; anyone with MANAGE_MESSAGES
/// can delete anyone's (moderation), matching Discord.
pub async fn delete_channel_message(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;

    let owner_row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT sender_id FROM guild_messages WHERE id = $1 AND channel_id = $2",
    )
    .bind(message_id)
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;
    let Some((sender_id,)) = owner_row else {
        return Err(not_found("message not found"));
    };

    if sender_id != me {
        require_permission(&state, guild_id, me, PERM_MANAGE_MESSAGES).await?;
    }

    let mut tx = state.db.begin().await.map_err(internal_err)?;
    sqlx::query("DELETE FROM guild_messages WHERE id = $1")
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;
    sqlx::query("DELETE FROM message_reactions WHERE message_id = $1 AND message_kind = 'guild'")
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(internal_err)?;
    tx.commit().await.map_err(internal_err)?;

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "guild_message_deleted", "guild_id": guild_id, "channel_id": channel_id, "message_id": message_id,
    })).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ReactGuildBody {
    pub emoji: String,
}

const MAX_EMOJI_LEN_GUILD: usize = 32;

/// `POST /guilds/:id/channels/:channel_id/messages/:message_id/reactions`
/// — toggle semantics, same as the DM equivalent in dms.rs.
pub async fn toggle_channel_reaction(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, channel_id, message_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<ReactGuildBody>,
) -> Result<Json<Vec<crate::dms::ReactionSummary>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_SEND_MESSAGES).await?;

    let emoji = body.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_LEN_GUILD {
        return Err(bad_request("invalid emoji"));
    }

    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM message_reactions WHERE message_id = $1 AND message_kind = 'guild' AND user_id = $2 AND emoji = $3",
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
            "INSERT INTO message_reactions (message_id, message_kind, user_id, emoji) VALUES ($1, 'guild', $2, $3)",
        )
        .bind(message_id)
        .bind(me)
        .bind(emoji)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;
    }

    let summary = crate::dms::reaction_summary(&state, message_id, me).await.map_err(internal_err)?;

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await
        .map_err(internal_err)?;
    let recipient_ids: Vec<Uuid> = members.into_iter().map(|(id,)| id).collect();
    state.ws_hub.send_to_many(&recipient_ids, json!({
        "type": "guild_reaction_update", "guild_id": guild_id, "channel_id": channel_id,
        "message_id": message_id, "reactions": &summary,
    })).await;

    Ok(Json(summary))
}

/// `GET /guilds/:id/roles` — ordered by position desc.
pub async fn list_roles(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Vec<RoleView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    assert_member(&state, guild_id, me).await?;

    let roles: Vec<RoleView> = sqlx::query_as(
        "SELECT id, guild_id, name, color, position, permissions, is_default
         FROM guild_roles WHERE guild_id = $1 ORDER BY position DESC",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(roles))
}

#[derive(Deserialize)]
pub struct CreateRoleBody {
    pub name: String,
    pub color: Option<String>,
    pub permissions: Option<i64>,
}

/// `POST /guilds/:id/roles` — requires MANAGE_ROLES.
pub async fn create_role(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    Json(body): Json<CreateRoleBody>,
) -> Result<Json<RoleView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_ROLES).await?;

    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("role name can't be empty"));
    }

    let (max_pos,): (Option<i32>,) = sqlx::query_as("SELECT MAX(position) FROM guild_roles WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
    let position = max_pos.unwrap_or(0) + 1;

    let role: RoleView = sqlx::query_as(
        "INSERT INTO guild_roles (guild_id, name, color, position, permissions)
         VALUES ($1, $2, COALESCE($3, '#8B93A1'), $4, COALESCE($5, 0))
         RETURNING id, guild_id, name, color, position, permissions, is_default",
    )
    .bind(guild_id)
    .bind(name)
    .bind(body.color)
    .bind(position)
    .bind(body.permissions)
    .fetch_one(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(role))
}

#[derive(Deserialize)]
pub struct UpdateRoleBody {
    pub name: Option<String>,
    pub color: Option<String>,
    pub permissions: Option<i64>,
    pub position: Option<i32>,
}

/// `PATCH /guilds/:id/roles/:role_id` — requires MANAGE_ROLES. The
/// `is_default` role's name/color/permissions/position remain editable
/// (Discord lets you rename/recolor/re-permission @everyone); only
/// deletion of it is blocked (see `delete_role`), since there's no field
/// here to toggle `is_default` itself.
pub async fn update_role(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, role_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateRoleBody>,
) -> Result<Json<RoleView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_ROLES).await?;

    let role: Option<RoleView> = sqlx::query_as(
        "UPDATE guild_roles SET
            name = COALESCE($3, name),
            color = COALESCE($4, color),
            permissions = COALESCE($5, permissions),
            position = COALESCE($6, position)
         WHERE id = $1 AND guild_id = $2
         RETURNING id, guild_id, name, color, position, permissions, is_default",
    )
    .bind(role_id)
    .bind(guild_id)
    .bind(body.name)
    .bind(body.color)
    .bind(body.permissions)
    .bind(body.position)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    role.map(Json).ok_or_else(|| not_found("role not found in this guild"))
}

/// `DELETE /guilds/:id/roles/:role_id` — requires MANAGE_ROLES, rejects
/// the `is_default` role.
pub async fn delete_role(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, role_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_ROLES).await?;

    let row: Option<(bool,)> =
        sqlx::query_as("SELECT is_default FROM guild_roles WHERE id = $1 AND guild_id = $2")
            .bind(role_id)
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;
    let Some((is_default,)) = row else {
        return Err(not_found("role not found in this guild"));
    };
    if is_default {
        return Err(bad_request("can't delete the @everyone role"));
    }

    sqlx::query("DELETE FROM guild_roles WHERE id = $1 AND guild_id = $2")
        .bind(role_id)
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /guilds/:id/members/:user_id/roles/:role_id` — idempotent assign.
pub async fn assign_role(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, user_id, role_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_ROLES).await?;

    let role_exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM guild_roles WHERE id = $1 AND guild_id = $2")
        .bind(role_id)
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;
    if role_exists.is_none() {
        return Err(not_found("role not found in this guild"));
    }
    assert_member(&state, guild_id, user_id).await.map_err(|_| not_found("that user isn't a member of this guild"))?;

    sqlx::query(
        "INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(role_id)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(json!({ "status": "ok" })))
}

/// `DELETE /guilds/:id/members/:user_id/roles/:role_id`
pub async fn unassign_role(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, user_id, role_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_ROLES).await?;

    sqlx::query("DELETE FROM guild_member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = $3")
        .bind(guild_id)
        .bind(user_id)
        .bind(role_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------

/// Base62, 8 characters, seeded from a UUIDv4's randomness — good enough
/// entropy (62^8 ≈ 2.18e14 combinations) without pulling in the `rand`
/// crate as a direct dependency; collisions are handled by the
/// retry-on-conflict loop in `create_invite` regardless.
fn generate_invite_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut n = Uuid::new_v4().as_u128();
    let mut out = Vec::with_capacity(8);
    for _ in 0..8 {
        let idx = (n % 62) as usize;
        out.push(ALPHABET[idx]);
        n /= 62;
    }
    String::from_utf8(out).expect("alphabet is ASCII")
}

#[derive(Deserialize)]
pub struct CreateInviteBody {
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i64>,
}

/// `POST /guilds/:id/invites` — requires MANAGE_GUILD.
///
/// Simplification: real Discord lets any member with CREATE_INSTANT_INVITE
/// make one, but that bit doesn't exist in the current bitfield (see
/// migration doc comment), so this gates on MANAGE_GUILD instead.
pub async fn create_invite(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
    Json(body): Json<CreateInviteBody>,
) -> Result<Json<InviteView>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_GUILD).await?;

    let expires_at = body.expires_in_hours.map(|h| Utc::now() + Duration::hours(h));

    let mut attempts = 0;
    loop {
        let code = generate_invite_code();
        let result: Result<InviteView, sqlx::Error> = sqlx::query_as(
            "INSERT INTO guild_invites (code, guild_id, created_by, max_uses, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING code, guild_id, created_by, max_uses, uses, expires_at, created_at",
        )
        .bind(&code)
        .bind(guild_id)
        .bind(me)
        .bind(body.max_uses)
        .bind(expires_at)
        .fetch_one(&state.db)
        .await;

        match result {
            Ok(invite) => return Ok(Json(invite)),
            Err(e) => {
                let is_code_conflict = e
                    .as_database_error()
                    .and_then(|de| de.code())
                    .map(|c| c == "23505")
                    .unwrap_or(false);
                attempts += 1;
                if is_code_conflict && attempts < 5 {
                    continue;
                }
                return Err(internal_err(e));
            }
        }
    }
}

/// `GET /guilds/:id/invites` — active invites only. Requires MANAGE_GUILD.
pub async fn list_invites(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(guild_id): Path<Uuid>,
) -> Result<Json<Vec<InviteView>>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_GUILD).await?;

    let invites: Vec<InviteView> = sqlx::query_as(
        "SELECT code, guild_id, created_by, max_uses, uses, expires_at, created_at
         FROM guild_invites
         WHERE guild_id = $1
           AND (expires_at IS NULL OR expires_at > now())
           AND (max_uses IS NULL OR uses < max_uses)
         ORDER BY created_at DESC",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(invites))
}

/// `DELETE /guilds/:id/invites/:code` — requires MANAGE_GUILD.
pub async fn revoke_invite(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path((guild_id, code)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;
    require_permission(&state, guild_id, me, PERM_MANAGE_GUILD).await?;

    sqlx::query("DELETE FROM guild_invites WHERE code = $1 AND guild_id = $2")
        .bind(code)
        .bind(guild_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /invites/:code` — public preview. Requires a valid Clerk JWT
/// (like everything else) but NOT guild membership; 404s if the code
/// doesn't exist, is expired, or is exhausted, so it can't be used to
/// enumerate valid-but-inaccessible codes.
pub async fn preview_invite(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    // Just needs to be a real authenticated user; no further use of `me`.
    let _me = local_user_id(&state, &claims.sub).await?;

    let row: Option<(Uuid, String, String, i64)> = sqlx::query_as(
        r#"
        SELECT g.id, g.name, g.icon_color,
               (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS member_count
        FROM guild_invites i
        JOIN guilds g ON g.id = i.guild_id
        WHERE i.code = $1
          AND (i.expires_at IS NULL OR i.expires_at > now())
          AND (i.max_uses IS NULL OR i.uses < i.max_uses)
        "#,
    )
    .bind(&code)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some((guild_id, name, icon_color, member_count)) = row else {
        return Err(not_found("invite not found, expired, or exhausted"));
    };

    Ok(Json(json!({
        "guild_id": guild_id,
        "name": name,
        "icon_color": icon_color,
        "member_count": member_count,
    })))
}

/// `POST /invites/:code/accept` — joins the guild (idempotent if already
/// a member).
pub async fn accept_invite(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let me = local_user_id(&state, &claims.sub).await?;

    let mut tx = state.db.begin().await.map_err(internal_err)?;

    let invite: Option<(Uuid, Option<i32>, i32, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT guild_id, max_uses, uses, expires_at FROM guild_invites WHERE code = $1 FOR UPDATE",
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal_err)?;

    let Some((guild_id, max_uses, uses, expires_at)) = invite else {
        return Err(not_found("invite not found"));
    };
    if let Some(exp) = expires_at {
        if exp <= Utc::now() {
            return Err(not_found("invite has expired"));
        }
    }
    if let Some(max) = max_uses {
        if uses >= max {
            return Err(not_found("invite has been used up"));
        }
    }

    let banned: Option<(Uuid,)> = sqlx::query_as(
        "SELECT guild_id FROM guild_bans WHERE guild_id = $1 AND user_id = $2",
    )
    .bind(guild_id)
    .bind(me)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal_err)?;
    if banned.is_some() {
        return Err(forbidden("you are banned from this server"));
    }

    let already_member: Option<(Uuid,)> =
        sqlx::query_as("SELECT guild_id FROM guild_members WHERE guild_id = $1 AND user_id = $2")
            .bind(guild_id)
            .bind(me)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal_err)?;

    if already_member.is_none() {
        sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)")
            .bind(guild_id)
            .bind(me)
            .execute(&mut *tx)
            .await
            .map_err(internal_err)?;

        let default_role: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM guild_roles WHERE guild_id = $1 AND is_default = true")
                .bind(guild_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal_err)?;
        if let Some((role_id,)) = default_role {
            sqlx::query(
                "INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(guild_id)
            .bind(me)
            .bind(role_id)
            .execute(&mut *tx)
            .await
            .map_err(internal_err)?;
        }

        sqlx::query("UPDATE guild_invites SET uses = uses + 1 WHERE code = $1")
            .bind(&code)
            .execute(&mut *tx)
            .await
            .map_err(internal_err)?;
    }

    tx.commit().await.map_err(internal_err)?;

    if already_member.is_none() {
        post_join_system_message(&state, guild_id, me).await;
    }

    Ok(Json(json!({ "guild_id": guild_id, "status": "joined" })))
}
