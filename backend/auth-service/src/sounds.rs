//! Per-user notification sound preferences (message beep + ringtone).
//! Each can be a built-in preset (matched against files shipped in the
//! frontend's /public/sounds) or a small user-uploaded custom clip stored
//! inline in Postgres — see migration 0003 for why (no object storage
//! service exists yet).

use axum::extract::{Multipart, Path as AxPath, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Serialize;
use serde_json::json;

use crate::clerk::ClerkUser;
use crate::AppState;

const MAX_UPLOAD_BYTES: usize = 2 * 1024 * 1024; // 2MB — inline-in-Postgres is only sane for short clips

async fn local_user_id(state: &AppState, clerk_sub: &str) -> Result<uuid::Uuid, (StatusCode, Json<serde_json::Value>)> {
    let row: Option<(uuid::Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE clerk_user_id = $1")
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

/// Which sound slot a request is about — kept to exactly these two values
/// throughout this module instead of a free-form string.
#[derive(Clone, Copy)]
pub enum Slot {
    Message,
    Ringtone,
}

impl Slot {
    fn from_str_param(s: &str) -> Result<Self, (StatusCode, Json<serde_json::Value>)> {
        match s {
            "message" => Ok(Slot::Message),
            "ringtone" => Ok(Slot::Ringtone),
            _ => Err((
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "slot must be 'message' or 'ringtone'" })),
            )),
        }
    }
    fn preset_col(&self) -> &'static str {
        match self {
            Slot::Message => "message_sound_preset",
            Slot::Ringtone => "ringtone_preset",
        }
    }
    fn custom_col(&self) -> &'static str {
        match self {
            Slot::Message => "message_sound_custom",
            Slot::Ringtone => "ringtone_custom",
        }
    }
    fn mime_col(&self) -> &'static str {
        match self {
            Slot::Message => "message_sound_custom_mime",
            Slot::Ringtone => "ringtone_custom_mime",
        }
    }
}

#[derive(Serialize)]
pub struct SoundSlotView {
    pub preset: Option<String>,
    pub has_custom: bool,
}

#[derive(Serialize)]
pub struct SoundsView {
    pub message: SoundSlotView,
    pub ringtone: SoundSlotView,
}

/// `GET /me/sounds`
pub async fn get_sounds(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<SoundsView>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    let row: Option<(Option<String>, bool, Option<String>, bool)> = sqlx::query_as(
        "SELECT message_sound_preset, message_sound_custom IS NOT NULL,
                ringtone_preset, ringtone_custom IS NOT NULL
         FROM user_sound_settings WHERE user_id = $1",
    )
    .bind(me)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let (msg_preset, msg_has_custom, ring_preset, ring_has_custom) =
        row.unwrap_or((None, false, None, false));

    Ok(Json(SoundsView {
        message: SoundSlotView { preset: msg_preset, has_custom: msg_has_custom },
        ringtone: SoundSlotView { preset: ring_preset, has_custom: ring_has_custom },
    }))
}

async fn ensure_row(state: &AppState, user_id: uuid::Uuid) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    sqlx::query("INSERT INTO user_sound_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING")
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct SetPresetBody {
    pub preset: String,
}

/// `PUT /me/sounds/:slot/preset` `{ "preset": "classic" }` — selects a
/// built-in sound and clears any custom upload for that slot.
pub async fn set_preset(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    AxPath(slot): AxPath<String>,
    Json(body): Json<SetPresetBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let slot = Slot::from_str_param(&slot)?;
    let me = local_user_id(&state, &claims.sub).await?;
    ensure_row(&state, me).await?;

    let sql = format!(
        "UPDATE user_sound_settings SET {} = $1, {} = NULL, {} = NULL, updated_at = now() WHERE user_id = $2",
        slot.preset_col(),
        slot.custom_col(),
        slot.mime_col(),
    );
    sqlx::query(&sql)
        .bind(&body.preset)
        .bind(me)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(Json(json!({ "status": "ok" })))
}

/// `POST /me/sounds/:slot/upload` — multipart file upload. Clears any
/// preset selection for that slot.
pub async fn upload_custom(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    AxPath(slot): AxPath<String>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let slot = Slot::from_str_param(&slot)?;
    let me = local_user_id(&state, &claims.sub).await?;
    ensure_row(&state, me).await?;

    let mut bytes: Option<Vec<u8>> = None;
    let mut mime = "audio/mpeg".to_string();

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("malformed upload: {e}") })),
        )
    })? {
        if field.name() == Some("file") {
            if let Some(ct) = field.content_type() {
                mime = ct.to_string();
            }
            let data = field.bytes().await.map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("failed reading upload: {e}") })),
                )
            })?;
            if data.len() > MAX_UPLOAD_BYTES {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(json!({ "error": "file too large — max 2MB" })),
                ));
            }
            bytes = Some(data.to_vec());
        }
    }

    let Some(bytes) = bytes else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing 'file' field" })),
        ));
    };

    let sql = format!(
        "UPDATE user_sound_settings SET {} = NULL, {} = $1, {} = $2, updated_at = now() WHERE user_id = $3",
        slot.preset_col(),
        slot.custom_col(),
        slot.mime_col(),
    );
    sqlx::query(&sql)
        .bind(&bytes)
        .bind(&mime)
        .bind(me)
        .execute(&state.db)
        .await
        .map_err(internal_err)?;

    Ok(Json(json!({ "status": "ok" })))
}

/// `GET /me/sounds/:slot/file` — streams the raw custom clip back (used to
/// build a playable blob URL client-side). 404s if no custom clip is set.
pub async fn get_custom_file(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    AxPath(slot): AxPath<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let slot = Slot::from_str_param(&slot)?;
    let me = local_user_id(&state, &claims.sub).await?;

    let sql = format!(
        "SELECT {}, {} FROM user_sound_settings WHERE user_id = $1",
        slot.custom_col(),
        slot.mime_col(),
    );
    let row: Option<(Option<Vec<u8>>, Option<String>)> = sqlx::query_as(&sql)
        .bind(me)
        .fetch_optional(&state.db)
        .await
        .map_err(internal_err)?;

    let Some((Some(bytes), mime)) = row else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no custom clip set for this slot" })),
        ));
    };

    let mime = mime.unwrap_or_else(|| "audio/mpeg".to_string());
    Ok(([(header::CONTENT_TYPE, mime)], bytes))
}
