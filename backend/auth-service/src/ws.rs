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
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::guilds;
use crate::AppState;

#[derive(Clone, Default)]
pub struct WsHub {
    connections: Arc<RwLock<HashMap<Uuid, Vec<mpsc::UnboundedSender<Value>>>>>,
    /// In-process voice-channel presence: channel_id -> set of user_ids
    /// currently "in" that voice channel. Purely in-memory, no DB table —
    /// matches this hub's existing in-memory-only philosophy (see module
    /// doc comment); presence resets on backend restart, which is fine
    /// since it's live-only signaling state, not history.
    voice_channels: Arc<RwLock<HashMap<Uuid, HashSet<Uuid>>>>,
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

    /// Adds `user_id` to the voice channel's presence set and returns
    /// everyone who was *already* in it (before this join), so the caller
    /// can send the joiner a snapshot and broadcast the join to the rest.
    pub async fn voice_join(&self, channel_id: Uuid, user_id: Uuid) -> Vec<Uuid> {
        let mut vc = self.voice_channels.write().await;
        let set = vc.entry(channel_id).or_default();
        let existing: Vec<Uuid> = set.iter().copied().collect();
        set.insert(user_id);
        existing
    }

    /// Removes `user_id` from the voice channel's presence set.
    pub async fn voice_leave(&self, channel_id: Uuid, user_id: Uuid) {
        let mut vc = self.voice_channels.write().await;
        if let Some(set) = vc.get_mut(&channel_id) {
            set.remove(&user_id);
            if set.is_empty() {
                vc.remove(&channel_id);
            }
        }
    }

    /// Current members of a voice channel (after any join/leave).
    pub async fn voice_members(&self, channel_id: Uuid) -> Vec<Uuid> {
        let vc = self.voice_channels.read().await;
        vc.get(&channel_id).map(|s| s.iter().copied().collect()).unwrap_or_default()
    }

    /// Every voice channel `user_id` currently appears in — used to clean
    /// up presence on socket disconnect (a user can only realistically be
    /// in one at a time client-side, but this doesn't assume that).
    pub async fn voice_channels_for_user(&self, user_id: Uuid) -> Vec<Uuid> {
        let vc = self.voice_channels.read().await;
        vc.iter()
            .filter(|(_, set)| set.contains(&user_id))
            .map(|(channel_id, _)| *channel_id)
            .collect()
    }

    pub async fn is_in_voice_channel(&self, channel_id: Uuid, user_id: Uuid) -> bool {
        let vc = self.voice_channels.read().await;
        vc.get(&channel_id).map(|s| s.contains(&user_id)).unwrap_or(false)
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

    // ---- Guild voice-channel presence + WebRTC mesh signaling ----
    // Unlike the 1:1 Call* variants above (keyed by dm_id, always exactly
    // two parties), a voice channel can have N participants, each needing
    // a separate mesh peer connection to every other participant. Offer/
    // Answer/IceCandidate are therefore relayed 1:1 via `to`, not broadcast
    // to the whole channel — same wire shape as Call*, just keyed by
    // (channel_id, to) instead of dm_id.
    VoiceJoin { channel_id: Uuid },
    VoiceLeave { channel_id: Uuid },
    VoiceOffer { channel_id: Uuid, to: Uuid, sdp: Value },
    VoiceAnswer { channel_id: Uuid, to: Uuid, sdp: Value },
    VoiceIceCandidate { channel_id: Uuid, to: Uuid, candidate: Value },
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

/// Looks up `channel_id`'s guild, confirms `user_id` is a guild member
/// with CONNECT permission on it, and returns the guild_id. Used to gate
/// `VoiceJoin`.
async fn assert_can_connect_voice(state: &AppState, channel_id: Uuid, user_id: Uuid) -> Option<Uuid> {
    let row: Option<(Uuid, String)> =
        match sqlx::query_as("SELECT guild_id, kind FROM guild_channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!("ws: failed to look up voice channel: {e}");
                return None;
            }
        };
    let (guild_id, kind) = row?;
    if kind != "voice" {
        return None;
    }
    match guilds::has_permission(state, guild_id, user_id, guilds::PERM_CONNECT).await {
        Ok(true) => Some(guild_id),
        Ok(false) => None,
        Err(e) => {
            tracing::warn!("ws: permission check failed: {e}");
            None
        }
    }
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

        ClientEvent::VoiceJoin { channel_id } => {
            if assert_can_connect_voice(state, channel_id, user_id).await.is_none() {
                tracing::warn!("ws: user {user_id} denied voice_join on channel {channel_id}");
                return;
            }
            let existing = state.ws_hub.voice_join(channel_id, user_id).await;

            // Tell the joiner who's already there so they can open mesh
            // connections to each of them.
            let snapshot = json!({
                "type": "voice_channel_state",
                "channel_id": channel_id,
                "members": existing,
            });
            state.ws_hub.send_to(user_id, snapshot).await;

            // Tell everyone already there that a new peer joined.
            let joined_payload = json!({
                "type": "voice_user_joined",
                "channel_id": channel_id,
                "user_id": user_id,
            });
            state.ws_hub.send_to_many(&existing, joined_payload).await;
        }
        ClientEvent::VoiceLeave { channel_id } => {
            state.ws_hub.voice_leave(channel_id, user_id).await;
            let remaining = state.ws_hub.voice_members(channel_id).await;
            let payload = json!({
                "type": "voice_user_left",
                "channel_id": channel_id,
                "user_id": user_id,
            });
            state.ws_hub.send_to_many(&remaining, payload).await;
        }
        ClientEvent::VoiceOffer { channel_id, to, sdp } => {
            if !state.ws_hub.is_in_voice_channel(channel_id, user_id).await {
                return;
            }
            let payload = json!({
                "type": "voice_offer",
                "channel_id": channel_id,
                "from": user_id,
                "sdp": sdp,
            });
            state.ws_hub.send_to(to, payload).await;
        }
        ClientEvent::VoiceAnswer { channel_id, to, sdp } => {
            if !state.ws_hub.is_in_voice_channel(channel_id, user_id).await {
                return;
            }
            let payload = json!({
                "type": "voice_answer",
                "channel_id": channel_id,
                "from": user_id,
                "sdp": sdp,
            });
            state.ws_hub.send_to(to, payload).await;
        }
        ClientEvent::VoiceIceCandidate { channel_id, to, candidate } => {
            if !state.ws_hub.is_in_voice_channel(channel_id, user_id).await {
                return;
            }
            let payload = json!({
                "type": "voice_ice_candidate",
                "channel_id": channel_id,
                "from": user_id,
                "candidate": candidate,
            });
            state.ws_hub.send_to(to, payload).await;
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

    // Clean up any voice-channel presence left behind by a closed tab/
    // socket so remaining participants don't see a ghost peer.
    for channel_id in state.ws_hub.voice_channels_for_user(user_id).await {
        state.ws_hub.voice_leave(channel_id, user_id).await;
        let remaining = state.ws_hub.voice_members(channel_id).await;
        let payload = json!({
            "type": "voice_user_left",
            "channel_id": channel_id,
            "user_id": user_id,
        });
        state.ws_hub.send_to_many(&remaining, payload).await;
    }

    tracing::info!("ws disconnected: user {user_id}");
}
