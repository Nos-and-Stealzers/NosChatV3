"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { WS_URL } from "@/lib/backend-api";
import { useSettings } from "@/lib/settings-context";

export type RealtimeEvent =
  | { type: "message"; message: import("@/lib/backend-api").Message }
  | { type: "friend_request"; friendship_id: string; from: string }
  | { type: "friend_accepted"; friendship_id: string; from: string }
  | { type: "typing"; dm_id: string; user_id: string }
  // Fanned out to every accepted friend whenever a user's effective status
  // (online/idle/dnd/offline) or status_text changes — see
  // backend/auth-service/src/profiles.rs `broadcast_presence`, called from
  // ws.rs on socket connect/disconnect and from profiles.rs on explicit
  // presence-mode / status_text edits.
  | {
      type: "presence_update";
      user_id: string;
      status: import("@/lib/backend-api").PresenceStatus;
      status_text: string | null;
    }
  | { type: "message_edited"; message: import("@/lib/backend-api").Message }
  | { type: "message_deleted"; dm_id: string; message_id: string }
  | {
      type: "reaction_update";
      dm_id: string;
      message_id: string;
      reactions: import("@/lib/backend-api").ReactionSummary[];
    }
  | {
      type: "guild_message_edited";
      guild_id: string;
      channel_id: string;
      message: import("@/lib/backend-api").GuildMessage;
    }
  | {
      type: "guild_message_deleted";
      guild_id: string;
      channel_id: string;
      message_id: string;
    }
  | {
      type: "guild_reaction_update";
      guild_id: string;
      channel_id: string;
      message_id: string;
      reactions: import("@/lib/backend-api").ReactionSummary[];
    }
  // Sent directly to a user's own client(s) the moment they're banned from
  // a guild, so an open tab on that guild's view navigates away instead of
  // looking accessible while actually cut off server-side (see guilds.rs
  // ban_member).
  | { type: "guild_banned"; guild_id: string }
  // --- WebRTC call signaling (server->client, fanned out from ws.rs) -----
  // Each carries `dm_id` + `from` (the sender's user id) so the recipient
  // knows which DM and who's calling/signaling, plus whatever payload that
  // signal type needs. The hub itself never inspects sdp/candidate — it's
  // an opaque relay, same pattern as `typing`.
  | { type: "call_ring"; dm_id: string; from: string; video: boolean }
  | { type: "call_offer"; dm_id: string; from: string; sdp: RTCSessionDescriptionInit }
  | { type: "call_answer"; dm_id: string; from: string; sdp: RTCSessionDescriptionInit }
  | {
      type: "call_ice_candidate";
      dm_id: string;
      from: string;
      candidate: RTCIceCandidateInit;
    }
  | { type: "call_end"; dm_id: string; from: string }
  | { type: "call_reject"; dm_id: string; from: string }
  // --- Guild (server) text messages + voice presence/signaling ----------
  // Mirrors the DM `message` event but scoped to a guild text channel.
  | {
      type: "guild_message";
      guild_id: string;
      channel_id: string;
      message: import("@/lib/backend-api").GuildMessage;
    }
  // Sent to a client right after it joins a voice channel — the full
  // roster of who's already connected, so it can open a peer connection to
  // each of them (mesh topology, see voice-context.tsx).
  | { type: "voice_channel_state"; channel_id: string; user_ids: string[] }
  | { type: "voice_user_joined"; channel_id: string; user_id: string }
  | { type: "voice_user_left"; channel_id: string; user_id: string }
  | {
      type: "voice_offer";
      channel_id: string;
      from: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "voice_answer";
      channel_id: string;
      from: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "voice_ice_candidate";
      channel_id: string;
      from: string;
      candidate: RTCIceCandidateInit;
    };

// Client->server call-signaling shapes sendCallSignal accepts — mirrors the
// backend's ClientEvent enum in ws.rs (minus Typing, which keeps its own
// dedicated sendTyping helper below).
export type CallSignal =
  | { type: "call_ring"; dm_id: string; video: boolean }
  | { type: "call_offer"; dm_id: string; sdp: RTCSessionDescriptionInit }
  | { type: "call_answer"; dm_id: string; sdp: RTCSessionDescriptionInit }
  | { type: "call_ice_candidate"; dm_id: string; candidate: RTCIceCandidateInit }
  | { type: "call_end"; dm_id: string }
  | { type: "call_reject"; dm_id: string };

// Client->server voice-channel signaling shapes sendGuildSignal accepts —
// mirrors the backend's ClientEvent enum's voice_* variants. Same
// fire-and-forget, no-retry-queue pattern as sendCallSignal.
export type GuildVoiceSignal =
  | { type: "voice_join"; channel_id: string }
  | { type: "voice_leave"; channel_id: string }
  | { type: "voice_offer"; channel_id: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "voice_answer"; channel_id: string; to: string; sdp: RTCSessionDescriptionInit }
  | {
      type: "voice_ice_candidate";
      channel_id: string;
      to: string;
      candidate: RTCIceCandidateInit;
    };

type Listener = (event: RealtimeEvent) => void;

type RealtimeContextValue = {
  subscribe: (listener: Listener) => () => void;
  // True only while the /ws socket is actually open — a real signal for the
  // UI to reflect (e.g. a "live" indicator), not a decorative always-on dot.
  connected: boolean;
  // Fire-and-forget: tells the backend "I'm typing in this DM right now" so
  // it can fan a `typing` event out to the other participant(s). No-ops
  // silently if the socket isn't open — typing presence is best-effort by
  // nature, not worth queuing or retrying.
  sendTyping: (dmId: string) => void;
  // Fire-and-forget: sends any call-signaling event (ring/offer/answer/ICE/
  // end/reject) up the same socket. No-ops silently if the socket isn't
  // open — call-context.tsx is responsible for treating that as a hard
  // failure (there's no retry queue here, same as sendTyping).
  sendCallSignal: (signal: CallSignal) => void;
  // Fire-and-forget: sends any guild voice-channel signaling event
  // (join/leave/offer/answer/ICE) up the same socket. Same no-op-if-closed
  // semantics as sendCallSignal/sendTyping.
  sendGuildSignal: (signal: GuildVoiceSignal) => void;
  // --- Developer-settings-gated debug surface --------------------------
  // Real state pulled straight from the live socket, exposed for the
  // Settings panel's WebSocket debug overlay (Developer category).
  reconnectCount: number;
  lastEventType: string | null;
  lastEventAt: string | null;
  // Forcibly closes the live socket — used by the Developer "Simulate
  // connection loss" button to exercise the real reconnect path.
  forceDisconnect: () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const RECONNECT_DELAY_MS = 2000;

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  const { settings } = useSettings();
  const listeners = useRef<Set<Listener>>(new Set());
  const socketRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [lastEventType, setLastEventType] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const isReconnectRef = useRef(false);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Clerk hands back a new `getToken` function identity on effectively every
  // render. Putting it in the connect-effect's dependency array meant the
  // effect's cleanup (socket.close()) fired on every re-render, then
  // reconnected 2s later — a permanent connect/disconnect loop, which is
  // why the "live" dot was actually flapping every few seconds instead of
  // staying steady. Route it through a ref instead so the socket effect
  // runs once per mount and reads whatever the latest getToken is only when
  // it actually needs a fresh token (initial connect + each reconnect).
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const [connected, setConnected] = useState(false);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const sendTyping = useCallback((dmId: string) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "typing", dm_id: dmId }));
    }
  }, []);

  const sendCallSignal = useCallback((signal: CallSignal) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(signal));
    }
  }, []);

  const sendGuildSignal = useCallback((signal: GuildVoiceSignal) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(signal));
    }
  }, []);

  useEffect(() => {
    stoppedRef.current = false;

    async function connect() {
      if (stoppedRef.current) return;
      const token = await getTokenRef.current();
      if (!token) {
        setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }

      const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        if (isReconnectRef.current) {
          if (settingsRef.current.verboseLogging) {
            console.log("[noschat:realtime] reconnected");
          }
        }
        isReconnectRef.current = true;
      };

      socket.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as RealtimeEvent;
          setLastEventType(parsed.type);
          setLastEventAt(new Date().toISOString());
          if (settingsRef.current.verboseLogging) {
            console.log("[noschat:realtime] event", parsed.type, parsed);
          }
          listeners.current.forEach((l) => l(parsed));
        } catch {
          // ignore malformed frames
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!stoppedRef.current) {
          setReconnectCount((c) => c + 1);
          setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
      socket.onerror = () => socket.close();
    }

    void connect();

    return () => {
      stoppedRef.current = true;
      setConnected(false);
      socketRef.current?.close();
    };
    // Intentionally run once per mount — see getTokenRef above.
  }, []);

  const forceDisconnect = useCallback(() => {
    socketRef.current?.close();
  }, []);

  return (
    <RealtimeContext.Provider
      value={{
        subscribe,
        connected,
        sendTyping,
        sendCallSignal,
        sendGuildSignal,
        reconnectCount,
        lastEventType,
        lastEventAt,
        forceDisconnect,
      }}
    >
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used within RealtimeProvider");
  return ctx;
}
