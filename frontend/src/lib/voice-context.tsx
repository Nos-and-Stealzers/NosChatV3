"use client";

// N-person mesh WebRTC voice for guild voice channels, signaled entirely
// over the existing WebSocket hub (see realtime-context.tsx's
// `sendGuildSignal`/`voice_*` events). This is the generalized-to-N-peers
// version of call-context.tsx's 1:1 pattern: joining a voice channel opens
// one RTCPeerConnection per *other* user already/currently in the channel,
// keyed by user_id instead of a single fixed remote. Audio-only in this
// pass — no camera — matching Discord's default voice channel behavior (a
// future "video in voice channel" feature could reuse call-context.tsx's
// camera/screen-share logic, generalized the same way this file
// generalizes its audio plumbing).
//
// Mesh join sequence per channel:
//   1. sendGuildSignal({ type: "voice_join", channel_id })
//   2. server replies with `voice_channel_state` listing everyone already
//      in the channel — for each of those user_ids we create a peer
//      connection and send them an offer (we're the "new" side, so we
//      initiate to everyone already present).
//   3. as further `voice_user_joined` events arrive for people joining
//      after us, we do nothing proactively — the newcomer initiates the
//      offer to us (symmetric with step 2, so exactly one offer exists per
//      pair, sent by whoever showed up second).
//   4. `voice_user_left` (or an explicit leave) tears down just that one
//      peer's connection, not the whole session.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRealtime, type RealtimeEvent } from "@/lib/realtime-context";
import { useSettings } from "@/lib/settings-context";

export type VoicePeerState = {
  stream: MediaStream | null;
  connectionState: string;
};

export type VoiceState = {
  channelId: string | null;
  guildId: string | null;
  peers: Record<string /* user_id */, VoicePeerState>;
  micMuted: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  screenSharingPeerIds: string[];
  localStream: MediaStream | null;
};

const IDLE_STATE: VoiceState = {
  channelId: null,
  guildId: null,
  peers: {},
  micMuted: false,
  cameraOn: false,
  screenSharing: false,
  screenSharingPeerIds: [],
  localStream: null,
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

type VoiceContextValue = {
  voice: VoiceState;
  joinVoiceChannel: (guildId: string, channelId: string) => Promise<void>;
  leaveVoiceChannel: () => void;
  toggleMic: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

// Per-peer mutable plumbing that doesn't belong in React state.
type PeerSession = {
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
};

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const { subscribe, sendGuildSignal } = useRealtime();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const [voice, setVoice] = useState<VoiceState>(IDLE_STATE);

  const channelIdRef = useRef<string | null>(null);
  const guildIdRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Record<string, PeerSession>>({});
  const micMutedRef = useRef(false);
  const cameraOnRef = useRef(false);
  const screenSharingRef = useRef(false);

  const buildAudioConstraints = useCallback((): MediaTrackConstraints | boolean => {
    const s = settingsRef.current;
    const constraints: MediaTrackConstraints = {
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
    };
    if (s.defaultMicDeviceId) constraints.deviceId = { exact: s.defaultMicDeviceId };
    return constraints;
  }, []);

  // Tears down one peer's connection only — used both for an explicit
  // `voice_user_left` and as a helper inside the full-session teardown.
  const teardownPeer = useCallback((userId: string) => {
    const session = peersRef.current[userId];
    if (!session) return;
    session.pc.ontrack = null;
    session.pc.onicecandidate = null;
    session.pc.oniceconnectionstatechange = null;
    session.pc.close();
    delete peersRef.current[userId];
    setVoice((prev) => {
      const next = { ...prev.peers };
      delete next[userId];
      return { ...prev, peers: next };
    });
  }, []);

  // Full teardown: leave the channel, close every peer, stop local tracks.
  const teardownAll = useCallback(() => {
    for (const userId of Object.keys(peersRef.current)) {
      teardownPeer(userId);
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    channelIdRef.current = null;
    guildIdRef.current = null;
    micMutedRef.current = false;
    cameraOnRef.current = false;
    screenSharingRef.current = false;
    setVoice(IDLE_STATE);
  }, [teardownPeer]);

  const buildPeerConnection = useCallback(
    (channelId: string, remoteUserId: string): PeerSession => {
      const pc = new RTCPeerConnection({
        iceServers: parseIceServers(),
        iceTransportPolicy: settingsRef.current.forceTurnRelay ? "relay" : "all",
      });
      const session: PeerSession = { pc, pendingCandidates: [] };
      peersRef.current[remoteUserId] = session;

      setVoice((prev) => ({
        ...prev,
        peers: {
          ...prev.peers,
          [remoteUserId]: { stream: null, connectionState: pc.connectionState },
        },
      }));

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          sendGuildSignal({
            type: "voice_ice_candidate",
            channel_id: channelId,
            to: remoteUserId,
            candidate: evt.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (evt) => {
        const [stream] = evt.streams;
        setVoice((prev) => ({
          ...prev,
          peers: {
            ...prev.peers,
            [remoteUserId]: {
              stream: stream ?? prev.peers[remoteUserId]?.stream ?? null,
              connectionState: pc.connectionState,
            },
          },
        }));
      };

      pc.onconnectionstatechange = () => {
        setVoice((prev) => {
          const existing = prev.peers[remoteUserId];
          if (!existing) return prev;
          return {
            ...prev,
            peers: {
              ...prev.peers,
              [remoteUserId]: { ...existing, connectionState: pc.connectionState },
            },
          };
        });
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          teardownPeer(remoteUserId);
        }
      };

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          pc.addTrack(track, localStreamRef.current);
        }
      }

      return session;
    },
    [sendGuildSignal, teardownPeer],
  );

  const flushPendingCandidates = useCallback(async (session: PeerSession) => {
    const queued = session.pendingCandidates;
    session.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await session.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("voice: failed to add queued ICE candidate", e);
      }
    }
  }, []);

  // Opens a peer connection to remoteUserId and sends it the initial
  // offer — used when we join and discover someone already present.
  const initiatePeer = useCallback(
    async (channelId: string, remoteUserId: string) => {
      const session = buildPeerConnection(channelId, remoteUserId);
      try {
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        sendGuildSignal({
          type: "voice_offer",
          channel_id: channelId,
          to: remoteUserId,
          sdp: offer as RTCSessionDescriptionInit,
        });
      } catch (e) {
        console.warn("voice: failed to create/send offer", e);
        teardownPeer(remoteUserId);
      }
    },
    [buildPeerConnection, sendGuildSignal, teardownPeer],
  );

  const joinVoiceChannel = useCallback(
    async (guildId: string, channelId: string) => {
      // Leave any currently-joined channel first (one voice channel at a
      // time, matching Discord's single-voice-connection-per-client model).
      if (channelIdRef.current) {
        teardownAll();
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(),
        });
        if (settingsRef.current.autoMuteOnJoin) {
          stream.getAudioTracks().forEach((t) => (t.enabled = false));
        }
        localStreamRef.current = stream;
        micMutedRef.current = settingsRef.current.autoMuteOnJoin;
        channelIdRef.current = channelId;
        guildIdRef.current = guildId;
        setVoice({
          channelId,
          guildId,
          peers: {},
          micMuted: micMutedRef.current,
          cameraOn: false,
          screenSharing: false,
          screenSharingPeerIds: [],
          localStream: stream,
        });
        sendGuildSignal({ type: "voice_join", channel_id: channelId });
      } catch (e) {
        console.warn("voice: failed to access microphone", e);
        teardownAll();
      }
    },
    [buildAudioConstraints, sendGuildSignal, teardownAll],
  );

  const leaveVoiceChannel = useCallback(() => {
    const channelId = channelIdRef.current;
    if (!channelId) return;
    sendGuildSignal({ type: "voice_leave", channel_id: channelId });
    teardownAll();
  }, [sendGuildSignal, teardownAll]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !micMutedRef.current;
    stream.getAudioTracks().forEach((t) => (t.enabled = !nextMuted));
    micMutedRef.current = nextMuted;
    setVoice((prev) => ({ ...prev, micMuted: nextMuted }));
  }, []);

  // Renegotiates every existing peer connection after the local track set
  // changes (camera on/off) — required because WebRTC only auto-includes
  // tracks present at initial offer time; adding/removing a track later
  // needs a fresh offer/answer round per peer. The existing `voice_offer`
  // handler in the subscribe effect below already treats an offer for an
  // *existing* session as a renegotiation (it just does setRemoteDescription
  // + createAnswer regardless of whether the session is brand new), so no
  // separate "renegotiation offer" event type is needed — this reuses the
  // exact same signaling path as the initial join.
  const renegotiateAllPeers = useCallback(
    async (channelId: string) => {
      for (const [remoteUserId, session] of Object.entries(peersRef.current)) {
        try {
          const offer = await session.pc.createOffer();
          await session.pc.setLocalDescription(offer);
          sendGuildSignal({
            type: "voice_offer",
            channel_id: channelId,
            to: remoteUserId,
            sdp: offer as RTCSessionDescriptionInit,
          });
        } catch (e) {
          console.warn(`voice: failed to renegotiate with ${remoteUserId}`, e);
        }
      }
    },
    [sendGuildSignal],
  );

  // Turns the local camera on/off mid-call, matching call-context.tsx's
  // 1:1 pattern but generalized to renegotiate with every mesh peer
  // instead of just one. Camera is off by default in voice channels
  // (audio-only, matching Discord's default) — this is purely opt-in.
  const toggleCamera = useCallback(async () => {
    const channelId = channelIdRef.current;
    if (!channelId) return;

    if (cameraOnRef.current) {
      // Turning off: stop the track, remove it from the local stream and
      // from every peer's sender, then renegotiate so peers stop expecting
      // a video track (avoids a black/frozen tile on their end).
      const stream = localStreamRef.current;
      const videoTrack = stream?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        stream?.removeTrack(videoTrack);
      }
      for (const session of Object.values(peersRef.current)) {
        const sender = session.pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) session.pc.removeTrack(sender);
      }
      cameraOnRef.current = false;
      setVoice((prev) => ({ ...prev, cameraOn: false, localStream: localStreamRef.current }));
      await renegotiateAllPeers(channelId);
      return;
    }

    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const [videoTrack] = videoStream.getVideoTracks();
      const stream = localStreamRef.current;
      if (stream) {
        stream.addTrack(videoTrack);
      } else {
        localStreamRef.current = videoStream;
      }
      for (const session of Object.values(peersRef.current)) {
        session.pc.addTrack(videoTrack, localStreamRef.current!);
      }
      cameraOnRef.current = true;
      setVoice((prev) => ({ ...prev, cameraOn: true, localStream: localStreamRef.current }));
      await renegotiateAllPeers(channelId);
    } catch (e) {
      console.warn("voice: failed to access camera", e);
    }
  }, [renegotiateAllPeers]);

  // Screen share reuses the SAME video track "slot" as the camera (mutually
  // exclusive — matches most lightweight WebRTC apps and keeps the peer
  // renegotiation logic identical for both: at most one video track is ever
  // sent at a time). Starting a share while the camera is on stops the
  // camera first. The browser's native "Stop sharing" UI fires the track's
  // own `onended` event, which we listen for to clean up automatically —
  // without that, clicking the native stop button would leave stale local
  // state claiming the share is still active.
  const toggleScreenShare = useCallback(async () => {
    const channelId = channelIdRef.current;
    if (!channelId) return;

    if (screenSharingRef.current) {
      const stream = localStreamRef.current;
      const videoTrack = stream?.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        stream?.removeTrack(videoTrack);
      }
      for (const session of Object.values(peersRef.current)) {
        const sender = session.pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) session.pc.removeTrack(sender);
      }
      screenSharingRef.current = false;
      setVoice((prev) => ({ ...prev, screenSharing: false, localStream: localStreamRef.current }));
      await renegotiateAllPeers(channelId);
      sendGuildSignal({ type: "voice_screen_share_state", channel_id: channelId, sharing: false });
      return;
    }

    try {
      // If the camera happens to be on, stop it first — only one video
      // track slot is supported at a time, and starting a share should
      // visibly replace whatever video was being sent, not stack on it.
      if (cameraOnRef.current) {
        const stream = localStreamRef.current;
        const camTrack = stream?.getVideoTracks()[0];
        if (camTrack) {
          camTrack.stop();
          stream?.removeTrack(camTrack);
        }
        for (const session of Object.values(peersRef.current)) {
          const sender = session.pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) session.pc.removeTrack(sender);
        }
        cameraOnRef.current = false;
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const [screenTrack] = displayStream.getVideoTracks();
      const stream = localStreamRef.current;
      if (stream) {
        stream.addTrack(screenTrack);
      } else {
        localStreamRef.current = displayStream;
      }
      for (const session of Object.values(peersRef.current)) {
        session.pc.addTrack(screenTrack, localStreamRef.current!);
      }
      // The browser's own "Stop sharing" bar/button ends the track directly
      // (bypassing our button entirely) — this is the only way to hear
      // about that and keep local state in sync.
      screenTrack.onended = () => {
        void toggleScreenShare();
      };
      screenSharingRef.current = true;
      setVoice((prev) => ({
        ...prev,
        screenSharing: true,
        cameraOn: false,
        localStream: localStreamRef.current,
      }));
      await renegotiateAllPeers(channelId);
      sendGuildSignal({ type: "voice_screen_share_state", channel_id: channelId, sharing: true });
    } catch (e) {
      console.warn("voice: failed to start screen share", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renegotiateAllPeers]);

  useEffect(() => {
    return subscribe(async (event: RealtimeEvent) => {
      switch (event.type) {
        case "voice_channel_state": {
          if (event.channel_id !== channelIdRef.current) return;
          for (const userId of event.user_ids) {
            if (peersRef.current[userId]) continue;
            void initiatePeer(event.channel_id, userId);
          }
          break;
        }
        case "voice_user_joined": {
          // The newcomer initiates the offer to us — nothing to do here
          // beyond making sure we don't already have a stale session for
          // them (defensive, shouldn't normally happen).
          if (event.channel_id !== channelIdRef.current) return;
          break;
        }
        case "voice_user_left": {
          if (event.channel_id !== channelIdRef.current) return;
          teardownPeer(event.user_id);
          setVoice((prev) => ({
            ...prev,
            screenSharingPeerIds: prev.screenSharingPeerIds.filter((id) => id !== event.user_id),
          }));
          break;
        }
        case "voice_screen_share_state": {
          if (event.channel_id !== channelIdRef.current) return;
          setVoice((prev) => ({
            ...prev,
            screenSharingPeerIds: event.sharing
              ? [...prev.screenSharingPeerIds.filter((id) => id !== event.user_id), event.user_id]
              : prev.screenSharingPeerIds.filter((id) => id !== event.user_id),
          }));
          break;
        }
        case "voice_offer": {
          if (event.channel_id !== channelIdRef.current) return;
          let session = peersRef.current[event.from];
          if (!session) {
            session = buildPeerConnection(event.channel_id, event.from);
          }
          try {
            await session.pc.setRemoteDescription(event.sdp);
            await flushPendingCandidates(session);
            const answer = await session.pc.createAnswer();
            await session.pc.setLocalDescription(answer);
            sendGuildSignal({
              type: "voice_answer",
              channel_id: event.channel_id,
              to: event.from,
              sdp: answer as RTCSessionDescriptionInit,
            });
          } catch (e) {
            console.warn("voice: failed to answer offer", e);
            teardownPeer(event.from);
          }
          break;
        }
        case "voice_answer": {
          if (event.channel_id !== channelIdRef.current) return;
          const session = peersRef.current[event.from];
          if (!session) return;
          try {
            await session.pc.setRemoteDescription(event.sdp);
            await flushPendingCandidates(session);
          } catch (e) {
            console.warn("voice: failed to set remote answer", e);
          }
          break;
        }
        case "voice_ice_candidate": {
          if (event.channel_id !== channelIdRef.current) return;
          const session = peersRef.current[event.from];
          if (!session || !session.pc.remoteDescription) {
            session?.pendingCandidates.push(event.candidate);
            return;
          }
          try {
            await session.pc.addIceCandidate(event.candidate);
          } catch (e) {
            console.warn("voice: failed to add ICE candidate", e);
          }
          break;
        }
        default:
          break;
      }
    });
  }, [subscribe, initiatePeer, buildPeerConnection, flushPendingCandidates, sendGuildSignal, teardownPeer]);

  // Belt-and-suspenders cleanup if the provider unmounts mid-call.
  useEffect(() => {
    return () => {
      for (const session of Object.values(peersRef.current)) {
        session.pc.close();
      }
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <VoiceContext.Provider
      value={{ voice, joinVoiceChannel, leaveVoiceChannel, toggleMic, toggleCamera, toggleScreenShare }}
    >
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice() {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoice must be used within VoiceProvider");
  return ctx;
}
