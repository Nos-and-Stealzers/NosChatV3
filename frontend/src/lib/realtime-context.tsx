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
  | { type: "call_reject"; dm_id: string; from: string };

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
