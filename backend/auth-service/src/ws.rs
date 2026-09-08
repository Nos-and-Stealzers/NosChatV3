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

/// Messages the client can send *up* the socket. Typing presence, plus
/// WebRTC call signaling (ring/offer/answer/ICE/end/reject) for 1:1 voice
/// and video calls — everything else (sending a message, friending, etc.)
/// goes through the regular HTTP API and gets fanned back out over the
/// socket from there.
///
/// `sdp` and `candidate` are passed through opaquely as `serde_json::Value`
/// — this hub never needs to understand SDP/ICE internals, it just relays
/// them verbatim to the other participant, same as it already does for
/// typing.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientEvent {
    Typing { dm_id: Uuid },
    /// Outbound call invite. `video` distinguishes a voice-only call from a
    /// video call so the callee's UI/getUserMedia request can match.
    CallRing { dm_id: Uuid, video: bool },
    CallOffer { dm_id: Uuid, sdp: Value },
    CallAnswer { dm_id: Uuid, sdp: Value },
    CallIceCandidate { dm_id: Uuid, candidate: Value },
    /// Hang up (from either side, at any point) or caller cancelling before
    /// the callee answers.
    CallEnd { dm_id: Uuid },
    /// Callee explicitly declining an incoming ring, before ever answering.
    CallReject { dm_id: Uuid },
}

/// Looks up the DM's participants, confirms `user_id` is actually one of
/// them (silently drops the event otherwise — this is public-facing input
/// off the socket), and returns everyone else in the DM to relay to.
/// Shared by typing and every call-signaling variant below.
async fn other_participants(state: &AppState, dm_id: Uuid, user_id: Uuid) -> Option<Vec<Uuid>> {
    let participants: Vec<(Uuid,)> =
        match sqlx::query_as("SELECT user_id FROM dm_participants WHERE dm_id = $1")
            .bind(dm_id)
            .fetch_all(&state.db)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("ws: failed to look up dm participants: {e}");
                return None;
            }
        };
    let ids: Vec<Uuid> = participants.into_iter().map(|(id,)| id).collect();
    if !ids.contains(&user_id) {
        return None;
    }
    Some(ids.into_iter().filter(|id| *id != user_id).collect())
}

/// No persistence — typing state and call signaling are both deliberately
/// ephemeral/live-only. Every call-signaling variant validates DM
/// membership the same way (via `other_participants`) before relaying, and
/// always includes the sender's `user_id` so the recipient knows who's
/// calling/signaling — the hub itself has no notion of "call state", it's
/// purely a relay; the actual call state machine lives client-side.
async fn handle_client_event(state: &AppState, user_id: Uuid, event: ClientEvent) {
    match event {
        ClientEvent::Typing { dm_id } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({ "type": "typing", "dm_id": dm_id, "user_id": user_id });
            state.ws_hub.send_to_many(&others, payload).await;
        }
        ClientEvent::CallRing { dm_id, video } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({
                "type": "call_ring",
                "dm_id": dm_id,
                "from": user_id,
                "video": video,
            });
            state.ws_hub.send_to_many(&others, payload).await;
        }
        ClientEvent::CallOffer { dm_id, sdp } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({
                "type": "call_offer",
                "dm_id": dm_id,
                "from": user_id,
                "sdp": sdp,
            });
            state.ws_hub.send_to_many(&others, payload).await;
        }
        ClientEvent::CallAnswer { dm_id, sdp } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({
                "type": "call_answer",
                "dm_id": dm_id,
                "from": user_id,
                "sdp": sdp,
            });
            state.ws_hub.send_to_many(&others, payload).await;
        }
        ClientEvent::CallIceCandidate { dm_id, candidate } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({
                "type": "call_ice_candidate",
                "dm_id": dm_id,
                "from": user_id,
                "candidate": candidate,
            });
            state.ws_hub.send_to_many(&others, payload).await;
        }
        ClientEvent::CallEnd { dm_id } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({ "type": "call_end", "dm_id": dm_id, "from": user_id });
            state.ws_hub.send_to_many(&others, payload).await;
        }
        ClientEvent::CallReject { dm_id } => {
            let Some(others) = other_participants(state, dm_id, user_id).await else {
                return;
            };
            let payload = json!({ "type": "call_reject", "dm_id": dm_id, "from": user_id });
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
