"use client";

// 1:1 WebRTC voice/video calling + screen sharing, signaled entirely over
// the existing WebSocket hub (see backend/auth-service/src/ws.rs and
// realtime-context.tsx's `sendCallSignal`/`call_*` events). Pure P2P — no
// SFU/TURN by default, matching the DM model's 1:1-only scope. See
// HOSTING.txt for the NEXT_PUBLIC_ICE_SERVERS / coturn story.
//
// State machine per call:
//   idle -> ringing-outgoing (caller, waiting for answer/reject)
//        -> ringing-incoming (callee, waiting for accept/decline)
//        -> connecting (answer exchanged, ICE still negotiating)
//        -> active (media flowing)
//        -> idle (hangup/reject/remote-end/failure — state is reset, not a
//                 separate "ended" value, so the UI just disappears; a
//                 lightweight one-shot `lastEndedReason` is exposed instead
//                 for a toast if the caller wants one)

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRealtime, type RealtimeEvent } from "@/lib/realtime-context";
import { useSoundSettings } from "@/lib/use-sound-settings";

export type CallStatus =
  | "idle"
  | "ringing-outgoing"
  | "ringing-incoming"
  | "connecting"
  | "active";

export type CallType = "voice" | "video";

export type CallState = {
  status: CallStatus;
  dmId: string | null;
  // The other participant's local user id — the UI resolves a display
  // name/avatar from its own friends/DMs list, call-context doesn't know
  // about usernames.
  peerUserId: string | null;
  callType: CallType | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micMuted: boolean;
  cameraOff: boolean;
  screenSharing: boolean;
  error: string | null;
};

const IDLE_STATE: CallState = {
  status: "idle",
  dmId: null,
  peerUserId: null,
  callType: null,
  localStream: null,
  remoteStream: null,
  micMuted: false,
  cameraOff: false,
  screenSharing: false,
  error: null,
};

function parseIceServers(): RTCIceServer[] {
  const raw = process.env.NEXT_PUBLIC_ICE_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through to the STUN-only default below
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

type CallContextValue = {
  call: CallState;
  // Caller-side: rings the peer, does NOT create the offer yet (waits for
  // the callee to actually accept — see handleAccept below — so we don't
  // grab the mic/camera or start ICE for a call nobody's picked up).
  startCall: (dmId: string, peerUserId: string, callType: CallType) => Promise<void>;
  // Caller-side: cancel before the callee has answered.
  cancelCall: () => void;
  // Callee-side: accept an incoming ring — grabs local media and waits for
  // the caller's offer (which arrives right after this, since the caller's
  // "ring accepted implicitly by an offer showing up" — see protocol notes
  // in ws.rs / this file's sequence comment below).
  acceptCall: () => Promise<void>;
  // Callee-side: decline an incoming ring outright.
  rejectCall: () => void;
  // Either side, any point in the call: full teardown.
  hangUp: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => Promise<void>;
};

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { subscribe, sendCallSignal, connected } = useRealtime();
  const sound = useSoundSettings();

  const [call, setCall] = useState<CallState>(IDLE_STATE);

  // Mutable call-session refs. These deliberately live outside React state
  // because they're plumbing (peer connection, raw streams, queued ICE
  // candidates) rather than render-relevant data, and reading fresh values
  // out of a ref sidesteps stale-closure bugs in the WS subscribe callback
  // below (subscribe is only wired up once per mount).
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const dmIdRef = useRef<string | null>(null);
  const peerUserIdRef = useRef<string | null>(null);
  const callTypeRef = useRef<CallType | null>(null);
  const roleRef = useRef<"caller" | "callee" | null>(null);
  // ICE candidates that arrive over the socket before we've set a remote
  // description yet (very possible — signaling and ICE gathering race)
  // get queued here and flushed once setRemoteDescription resolves.
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const ringLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRingLoop = useCallback(() => {
    if (ringLoopRef.current) {
      clearInterval(ringLoopRef.current);
      ringLoopRef.current = null;
    }
  }, []);

  // Full teardown: stop every local/screen track, close the peer
  // connection, clear every ref, reset state to idle. Safe to call
  // multiple times (e.g. both a remote `call_end` and a local hangUp()
  // racing) — every step guards against already-null/closed.
  const teardown = useCallback(() => {
    stopRingLoop();

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;

    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    cameraTrackRef.current?.stop();
    cameraTrackRef.current = null;

    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    videoSenderRef.current = null;
    dmIdRef.current = null;
    peerUserIdRef.current = null;
    callTypeRef.current = null;
    roleRef.current = null;
    pendingCandidatesRef.current = [];

    setCall(IDLE_STATE);
  }, [stopRingLoop]);

  // Sends CallEnd for whatever DM we're currently in (if any) then tears
  // down locally. Used by both explicit hangUp() and any local failure
  // path (so the peer isn't left ringing/connected to a socket that just
  // silently vanished).
  const endAndNotify = useCallback(() => {
    if (dmIdRef.current) {
      sendCallSignal({ type: "call_end", dm_id: dmIdRef.current });
    }
    teardown();
  }, [sendCallSignal, teardown]);

  const buildPeerConnection = useCallback(
    (dmId: string) => {
      const pc = new RTCPeerConnection({ iceServers: parseIceServers() });

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          sendCallSignal({
            type: "call_ice_candidate",
            dm_id: dmId,
            candidate: evt.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (evt) => {
        const [stream] = evt.streams;
        setCall((prev) => ({ ...prev, remoteStream: stream ?? prev.remoteStream }));
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === "connected" || state === "completed") {
          setCall((prev) =>
            prev.status === "connecting" ? { ...prev, status: "active" } : prev,
          );
        } else if (state === "failed" || state === "disconnected" || state === "closed") {
          if (state === "failed") {
            // Disconnected can recover on its own (brief network blip);
            // failed means ICE gave up — tear the call down rather than
            // leaving a permanently broken connection in "active" state.
            endAndNotify();
          }
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [sendCallSignal, endAndNotify],
  );

  const attachLocalTracks = useCallback((pc: RTCPeerConnection, stream: MediaStream) => {
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (track.kind === "video") {
        videoSenderRef.current = sender;
        cameraTrackRef.current = track;
      }
    }
  }, []);

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("call: failed to add queued ICE candidate", e);
      }
    }
  }, []);

  // --- Caller flow ----------------------------------------------------

  const startCall = useCallback(
    async (dmId: string, peerUserId: string, callType: CallType) => {
      if (call.status !== "idle" || !connected) return;
      dmIdRef.current = dmId;
      peerUserIdRef.current = peerUserId;
      callTypeRef.current = callType;
      roleRef.current = "caller";
      setCall({
        ...IDLE_STATE,
        status: "ringing-outgoing",
        dmId,
        peerUserId,
        callType,
      });
      sendCallSignal({ type: "call_ring", dm_id: dmId, video: callType === "video" });
    },
    [call.status, connected, sendCallSignal],
  );

  const cancelCall = useCallback(() => {
    if (call.status !== "ringing-outgoing") return;
    endAndNotify();
  }, [call.status, endAndNotify]);

  // Once the callee's `call_answer` SDP arrives, the caller finally grabs
  // local media, builds the peer connection, creates+sends the offer is
  // NOT needed here — the caller actually creates the OFFER as soon as
  // ringing starts to succeed would require the callee to already be
  // ready. Simpler and matches standard "polite peer" caller-offers-first
  // practice: the caller creates the offer immediately after the callee's
  // ring is accepted, signaled by the callee sending a `call_ring` back is
  // unnecessary — instead the callee answers a `call_offer` directly. See
  // the protocol walkthrough in this file's header/docs for the exact
  // sequence: ring -> (callee accepts locally, no wire message needed for
  // "accept" other than the answer that follows) -> caller sends offer ->
  // callee sends answer -> both exchange ICE.
  //
  // To make that concrete: the callee's acceptCall() below grabs its local
  // media and immediately creates+sends the OFFER (flipping caller/callee
  // roles from "who rang" to "who has media ready first" would be
  // confusing) — instead we keep it simple: whichever side has local media
  // first sends the offer. Since ringing already tells the callee a call
  // type (voice/video) before they accept, the callee can grab media and
  // send the offer as soon as they accept, and the original caller replies
  // with an answer once its own media is ready. This avoids a redundant
  // extra "accept" round-trip message.
  const acceptCall = useCallback(async () => {
    if (call.status !== "ringing-incoming" || !dmIdRef.current || !callTypeRef.current) return;
    stopRingLoop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callTypeRef.current === "video",
      });
      localStreamRef.current = stream;
      setCall((prev) => ({ ...prev, status: "connecting", localStream: stream }));

      const pc = buildPeerConnection(dmIdRef.current);
      attachLocalTracks(pc, stream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendCallSignal({
        type: "call_offer",
        dm_id: dmIdRef.current,
        sdp: offer as RTCSessionDescriptionInit,
      });
    } catch (e) {
      setCall((prev) => ({
        ...prev,
        error: e instanceof Error ? e.message : "Could not access camera/microphone",
      }));
      endAndNotify();
    }
  }, [call.status, buildPeerConnection, attachLocalTracks, sendCallSignal, endAndNotify, stopRingLoop]);

  const rejectCall = useCallback(() => {
    if (call.status !== "ringing-incoming" || !dmIdRef.current) return;
    stopRingLoop();
    sendCallSignal({ type: "call_reject", dm_id: dmIdRef.current });
    teardown();
  }, [call.status, sendCallSignal, teardown, stopRingLoop]);

  const hangUp = useCallback(() => {
    if (call.status === "idle") return;
    endAndNotify();
  }, [call.status, endAndNotify]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !call.micMuted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !nextMuted));
    setCall((prev) => ({ ...prev, micMuted: nextMuted }));
  }, [call.micMuted]);

  const toggleCamera = useCallback(() => {
    if (callTypeRef.current !== "video") return;
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextOff = !call.cameraOff;
    stream.getVideoTracks().forEach((t) => (t.enabled = !nextOff));
    setCall((prev) => ({ ...prev, cameraOff: nextOff }));
  }, [call.cameraOff]);

  const toggleScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !videoSenderRef.current) return;

    if (call.screenSharing) {
      // Switch back to the camera track without renegotiating — same
      // sender, just a different underlying track via replaceTrack.
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      if (cameraTrackRef.current) {
        await videoSenderRef.current.replaceTrack(cameraTrackRef.current);
      }
      setCall((prev) => ({ ...prev, screenSharing: false }));
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const [screenTrack] = displayStream.getVideoTracks();
      screenStreamRef.current = displayStream;
      await videoSenderRef.current.replaceTrack(screenTrack);
      setCall((prev) => ({ ...prev, screenSharing: true }));

      // Browser-native "Stop sharing" control ends the track directly —
      // catch that to flip back to camera automatically instead of leaving
      // a dead outgoing video track.
      screenTrack.onended = () => {
        void toggleScreenShare();
      };
    } catch (e) {
      // User cancelled the picker, or getDisplayMedia isn't available —
      // either way, no-op back to whatever was already showing.
      console.warn("call: screen share failed/cancelled", e);
    }
    // Deliberately excludes call.screenSharing/toggleScreenShare itself
    // from deps beyond what's listed — this callback recreates each render
    // where call.screenSharing changes, which is exactly what we want so
    // the closure's "which branch" check stays fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.screenSharing]);

  // --- Incoming signaling ----------------------------------------------

  useEffect(() => {
    return subscribe(async (event: RealtimeEvent) => {
      switch (event.type) {
        case "call_ring": {
          // Ignore rings for any DM other than idle state — no call
          // waiting/multi-call support (matches the 1:1-only DM model this
          // is signaled over); a second incoming ring while already on/in
          // a call is silently dropped rather than interrupting the first.
          if (call.status !== "idle") return;
          dmIdRef.current = event.dm_id;
          peerUserIdRef.current = event.from;
          callTypeRef.current = event.video ? "video" : "voice";
          roleRef.current = "callee";
          setCall({
            ...IDLE_STATE,
            status: "ringing-incoming",
            dmId: event.dm_id,
            peerUserId: event.from,
            callType: event.video ? "video" : "voice",
          });
          stopRingLoop();
          void sound.play("ringtone");
          ringLoopRef.current = setInterval(() => {
            void sound.play("ringtone");
          }, 2000);
          break;
        }

        case "call_offer": {
          // Only meaningful once we've already accepted the ring and are
          // waiting to receive the offer (role: caller here, since the
          // callee is the one who sends the offer immediately on accept —
          // see acceptCall's comment). Ignore anything that doesn't match
          // our current dm/role.
          if (
            event.dm_id !== dmIdRef.current ||
            roleRef.current !== "caller" ||
            call.status !== "ringing-outgoing"
          ) {
            return;
          }
          stopRingLoop();
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: callTypeRef.current === "video",
            });
            localStreamRef.current = stream;
            setCall((prev) => ({ ...prev, status: "connecting", localStream: stream }));

            const pc = buildPeerConnection(event.dm_id);
            attachLocalTracks(pc, stream);

            await pc.setRemoteDescription(event.sdp);
            await flushPendingCandidates(pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendCallSignal({
              type: "call_answer",
              dm_id: event.dm_id,
              sdp: answer as RTCSessionDescriptionInit,
            });
          } catch (e) {
            setCall((prev) => ({
              ...prev,
              error: e instanceof Error ? e.message : "Could not access camera/microphone",
            }));
            endAndNotify();
          }
          break;
        }

        case "call_answer": {
          const pc = pcRef.current;
          if (!pc || event.dm_id !== dmIdRef.current || roleRef.current !== "callee") return;
          await pc.setRemoteDescription(event.sdp);
          await flushPendingCandidates(pc);
          break;
        }

        case "call_ice_candidate": {
          const pc = pcRef.current;
          if (event.dm_id !== dmIdRef.current) return;
          if (!pc || !pc.remoteDescription) {
            pendingCandidatesRef.current.push(event.candidate);
            return;
          }
          try {
            await pc.addIceCandidate(event.candidate);
          } catch (e) {
            console.warn("call: failed to add ICE candidate", e);
          }
          break;
        }

        case "call_end": {
          if (event.dm_id !== dmIdRef.current) return;
          stopRingLoop();
          teardown();
          break;
        }

        case "call_reject": {
          if (event.dm_id !== dmIdRef.current) return;
          stopRingLoop();
          teardown();
          break;
        }

        default:
          break;
      }
    });
  }, [
    subscribe,
    call.status,
    sound,
    buildPeerConnection,
    attachLocalTracks,
    flushPendingCandidates,
    sendCallSignal,
    endAndNotify,
    teardown,
    stopRingLoop,
  ]);

  // Belt-and-suspenders cleanup if the whole provider unmounts mid-call
  // (e.g. navigating away/app shell unmounting) — stop every track and
  // close the peer connection rather than leaking an open mic/camera.
  useEffect(() => {
    return () => {
      stopRingLoop();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      pcRef.current?.close();
    };
  }, [stopRingLoop]);

  return (
    <CallContext.Provider
      value={{
        call,
        startCall,
        cancelCall,
        acceptCall,
        rejectCall,
        hangUp,
        toggleMic,
        toggleCamera,
        toggleScreenShare,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}
