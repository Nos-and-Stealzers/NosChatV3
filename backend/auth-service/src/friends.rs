//! Friend requests and the friends list. See master spec Section 9.2.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
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

#[derive(Deserialize)]
pub struct SendRequestBody {
    /// Username of the person to add — matches what's shown in their
    /// profile, not their Clerk id.
    pub username: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct FriendshipView {
    pub id: Uuid,
    pub status: String,
    pub direction: String, // "incoming" | "outgoing" | "self" (accepted, either direction)
    pub user_id: Uuid,
    pub username: Option<String>,
    pub email: String,
}

/// `POST /friends/requests` `{ "username": "..." }` — sends a friend
/// request. Idempotent-ish: re-sending after a decline flips it back to
/// pending; sending to someone who already requested you auto-accepts.
pub async fn send_request(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Json(body): Json<SendRequestBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    let target: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM users WHERE lower(username) = lower($1)")
            .bind(&body.username)
            .fetch_optional(&state.db)
            .await
            .map_err(internal_err)?;

    let Some((target_id,)) = target else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("no user with username '{}'", body.username) })),
        ));
    };

    if target_id == me {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "can't friend yourself" })),
        ));
    }

    // Is there already a row for this pair, in either direction?
    let existing: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id, requester_id, status FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
            OR (requester_id = $2 AND addressee_id = $1)",
    )
    .bind(me)
    .bind(target_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let (friendship_id, became_accepted) = if let Some((id, requester_id, status)) = existing {
        if status == "accepted" {
            return Ok(Json(json!({ "status": "accepted", "id": id })));
        }
        if requester_id != me && status == "pending" {
            // They'd already requested us — this call accepts it instead of
            // creating a duplicate.
            sqlx::query("UPDATE friendships SET status = 'accepted', updated_at = now() WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await
                .map_err(internal_err)?;
            (id, true)
        } else {
            sqlx::query(
                "UPDATE friendships SET requester_id = $2, addressee_id = $3, status = 'pending', updated_at = now() WHERE id = $1",
            )
            .bind(id)
            .bind(me)
            .bind(target_id)
            .execute(&state.db)
            .await
            .map_err(internal_err)?;
            (id, false)
        }
    } else {
        let row: (Uuid,) = sqlx::query_as(
            "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending') RETURNING id",
        )
        .bind(me)
        .bind(target_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal_err)?;
        (row.0, false)
    };

    let event_type = if became_accepted { "friend_accepted" } else { "friend_request" };
    state
        .ws_hub
        .send_to(target_id, json!({ "type": event_type, "friendship_id": friendship_id, "from": me }))
        .await;

    Ok(Json(json!({ "status": if became_accepted { "accepted" } else { "pending" }, "id": friendship_id })))
}

/// `POST /friends/requests/:id/accept`
pub async fn accept_request(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE friendships SET status = 'accepted', updated_at = now()
         WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING requester_id, addressee_id",
    )
    .bind(id)
    .bind(me)
    .fetch_optional(&state.db)
    .await
    .map_err(internal_err)?;

    let Some((requester_id, _)) = row else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no pending request with that id addressed to you" })),
        ));
    };

    state
        .ws_hub
        .send_to(requester_id, json!({ "type": "friend_accepted", "friendship_id": id, "from": me }))
        .await;

    Ok(Json(json!({ "status": "accepted" })))
}

/// `POST /friends/requests/:id/decline`
pub async fn decline_request(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    sqlx::query(
        "UPDATE friendships SET status = 'declined', updated_at = now()
         WHERE id = $1 AND addressee_id = $2 AND status = 'pending'",
    )
    .bind(id)
    .bind(me)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(json!({ "status": "declined" })))
}

/// `DELETE /friends/:id` — removes an accepted friendship (or cancels an
/// outgoing request you sent).
pub async fn remove_friend(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    sqlx::query(
        "DELETE FROM friendships WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)",
    )
    .bind(id)
    .bind(me)
    .execute(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /friends` — everyone with an accepted friendship, plus incoming and
/// outgoing pending requests, all in one list distinguished by `status`/
/// `direction`.
pub async fn list_friends(
    State(state): State<AppState>,
    ClerkUser(claims): ClerkUser,
) -> Result<Json<Vec<FriendshipView>>, (StatusCode, Json<serde_json::Value>)> {
    let me = local_user_id(&state, &claims.sub).await?;

    let rows: Vec<FriendshipView> = sqlx::query_as(
        r#"
        SELECT
            f.id,
            f.status,
            CASE
                WHEN f.status = 'accepted' THEN 'self'
                WHEN f.requester_id = $1 THEN 'outgoing'
                ELSE 'incoming'
            END AS direction,
            u.id AS user_id,
            u.username,
            u.email
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = $1 OR f.addressee_id = $1)
          AND f.status IN ('pending', 'accepted')
        ORDER BY f.updated_at DESC
        "#,
    )
    .bind(me)
    .fetch_all(&state.db)
    .await
    .map_err(internal_err)?;

    Ok(Json(rows))
}
