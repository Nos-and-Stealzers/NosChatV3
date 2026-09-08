//! In-process WebSocket hub for real-time fan-out (new messages, friend
//! requests, typing indicators). One user can have multiple live
//! connections (multiple tabs/devices), so we keep a Vec of senders per
//! user id and clean up dead ones lazily on send failure.
//!
//! This is in-memory, single-process fan-out — fine for one backend
//! instance. The spec's long-term design (Section 8.1) is Redis pub/sub so
//! multiple backend instances can fan out to each other's connections;
//! revisit if this ever runs as more than one process.

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::AppState;

#[derive(Clone, Default)]
pub struct WsHub {
    connections: Arc<RwLock<HashMap<Uuid, Vec<mpsc::UnboundedSender<Value>>>>>,
}

impl WsHub {
    pub async fn register(&self, user_id: Uuid) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.connections.write().await.entry(user_id).or_default().push(tx);
        rx
    }

    /// Drops every sender for this user whose receiver has already closed —
    /// called opportunistically rather than tracking connection identity.
    pub async fn prune(&self, user_id: Uuid) {
        let mut conns = self.connections.write().await;
        if let Some(v) = conns.get_mut(&user_id) {
            v.retain(|tx| !tx.is_closed());
            if v.is_empty() {
                conns.remove(&user_id);
            }
        }
    }

    pub async fn send_to(&self, user_id: Uuid, payload: Value) {
        let conns = self.connections.read().await;
        if let Some(senders) = conns.get(&user_id) {
            for tx in senders {
                let _ = tx.send(payload.clone());
            }
        }
    }

    pub async fn send_to_many(&self, user_ids: &[Uuid], payload: Value) {
        for id in user_ids {
            self.send_to(*id, payload.clone()).await;
        }
    }
}

#[derive(Deserialize)]
pub struct WsAuthQuery {
    token: String,
}

/// Messages the client can send *up* the socket. Currently just typing
/// presence — everything else (sending a message, friending, etc.) goes
/// through the regular HTTP API and gets fanned back out over the socket
/// from there.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientEvent {
    Typing { dm_id: Uuid },
}

/// Looks up the DM's participants, confirms `user_id` is actually one of
/// them (silently drops the event otherwise — this is public-facing input
/// off the socket), and fans the typing event out to everyone else in the
/// DM. No persistence — typing state is deliberately ephemeral; the client
/// expires its own "is typing" flag a few seconds after the last event.
async fn handle_client_event(state: &AppState, user_id: Uuid, event: ClientEvent) {
    match event {
        ClientEvent::Typing { dm_id } => {
            let participants: Vec<(Uuid,)> =
                match sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
                    .bind(dm_id)
                    .fetch_all(&state.db)
                    .await
                {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::warn!("typing: failed to look up dm participants: {e}");
                        return;
                    }
                };
            let ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
            if !ids.contains(&user_id) {
                return;
            }
            let others: Vec<Uuid> = ids.into_iter().filter(|id| *id != user_id).collect();
            let payload = json!({ "type": "typing", "dm_id": dm_id, "user_id": user_id });
            state.ws_hub.send_to_many(&others, payload).await;
        }
    }
}

/// `GET /ws?token=<clerk session jwt>` — browsers can't set custom headers
/// on the WebSocket handshake, so the Clerk token travels as a query param
/// here instead of the `Authorization` header used everywhere else.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Query(auth): Query<WsAuthQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let claims = match state.clerk_verifier.verify(&auth.token).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("ws upgrade rejected: invalid token: {e}");
            return axum::http::StatusCode::UNAUTHORIZED.into_response();
        }
    };

    let user: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM users WHERE clerk_user_id = $1")
            .bind(&claims.sub)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);

    let Some((user_id,)) = user else {
        tracing::warn!("ws upgrade rejected: no local user row for {}", claims.sub);
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };

    ws.on_upgrade(move |socket| handle_socket(socket, state, user_id))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: Uuid) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.ws_hub.register(user_id).await;

    tracing::info!("ws connected: user {user_id}");

    let mut send_task = tokio::spawn(async move {
        while let Some(payload) = rx.recv().await {
            let text = payload.to_string();
            if sender.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Client->server traffic: typing events parsed and fanned out here;
    // anything else (unparseable frames, pings) is drained and ignored so
    // the connection doesn't look hung.
    let state_for_recv = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                WsMessage::Close(_) => break,
                WsMessage::Text(text) => {
                    if let Ok(event) = serde_json::from_str::<ClientEvent>(&text) {
                        handle_client_event(&state_for_recv, user_id, event).await;
                    }
                }
                _ => {}
            }
        }
        state_for_recv.ws_hub.prune(user_id).await;
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    state.ws_hub.prune(user_id).await;
    tracing::info!("ws disconnected: user {user_id}");
}
