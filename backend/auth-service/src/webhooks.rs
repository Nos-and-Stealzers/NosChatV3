//! `POST /webhooks/clerk` — keeps the local `users` table in sync with
//! Clerk, which is now the source of truth for identity/credentials. This
//! backend never creates or deletes a user directly; it only ever reacts to
//! Clerk telling it a user changed.
//!
//! Signature verification uses Svix (the webhook infra Clerk is built on)
//! against `CLERK_WEBHOOK_SECRET` — get this from the Clerk dashboard's
//! webhook endpoint config, NOT the same as `CLERK_SECRET_KEY`.
//!
//! Handles `user.created`, `user.updated`, `user.deleted`. Any other event
//! type is accepted (200) and ignored, since Clerk will retry on non-2xx and
//! we don't want unrelated event types (e.g. session events, if ever
//! subscribed) to look like a persistent failure.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use svix::webhooks::Webhook;

use crate::AppState;

#[derive(Debug, Deserialize)]
struct ClerkEvent {
    #[serde(rename = "type")]
    event_type: String,
    data: ClerkUserData,
}

#[derive(Debug, Deserialize)]
struct ClerkUserData {
    id: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    email_addresses: Vec<ClerkEmail>,
    #[serde(default)]
    primary_email_address_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClerkEmail {
    id: String,
    email_address: String,
}

impl ClerkUserData {
    fn primary_email(&self) -> Option<&str> {
        let target = self.primary_email_address_id.as_deref();
        self.email_addresses
            .iter()
            .find(|e| target.is_some_and(|t| t == e.id))
            .or_else(|| self.email_addresses.first())
            .map(|e| e.email_address.as_str())
    }
}

pub async fn clerk_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let secret = state.clerk_webhook_secret.as_deref().ok_or_else(|| {
        tracing::error!("CLERK_WEBHOOK_SECRET not set — cannot verify incoming webhooks");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "webhook verification not configured" })),
        )
    })?;

    let wh = Webhook::new(secret).map_err(|e| {
        tracing::error!("invalid CLERK_WEBHOOK_SECRET: {e}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "webhook verification not configured" })),
        )
    })?;

    wh.verify(&body, &headers).map_err(|e| {
        tracing::warn!("clerk webhook signature verification failed: {e}");
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid signature" })),
        )
    })?;

    let event: ClerkEvent = serde_json::from_slice(&body).map_err(|e| {
        tracing::warn!("clerk webhook payload didn't parse: {e}");
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed payload" })),
        )
    })?;

    match event.event_type.as_str() {
        "user.created" | "user.updated" => {
            let Some(email) = event.data.primary_email() else {
                tracing::warn!(
                    "clerk {} event for {} had no primary email — skipping sync",
                    event.event_type,
                    event.data.id
                );
                return Ok(StatusCode::OK);
            };

            sqlx::query(
                r#"
                INSERT INTO users (clerk_user_id, email, username)
                VALUES ($1, $2, $3)
                ON CONFLICT (clerk_user_id) DO UPDATE
                    SET email = EXCLUDED.email,
                        username = EXCLUDED.username,
                        updated_at = now()
                "#,
            )
            .bind(&event.data.id)
            .bind(email)
            .bind(&event.data.username)
            .execute(&state.db)
            .await
            .map_err(|e| {
                tracing::error!("failed to sync clerk user {}: {e:#}", event.data.id);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "sync failed" })),
                )
            })?;
        }
        "user.deleted" => {
            sqlx::query("DELETE FROM users WHERE clerk_user_id = $1")
                .bind(&event.data.id)
                .execute(&state.db)
                .await
                .map_err(|e| {
                    tracing::error!("failed to delete clerk user {}: {e:#}", event.data.id);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "sync failed" })),
                    )
                })?;
        }
        other => {
            tracing::debug!("ignoring unhandled clerk webhook event type: {other}");
        }
    }

    Ok(StatusCode::OK)
}
