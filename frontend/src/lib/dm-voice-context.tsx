"use client";

// N-person mesh WebRTC voice/video for GROUP DMs — parallel implementation
// of voice-context.tsx's guild-voice-channel mesh, keyed by dm_id instead
// of channel_id and signaled via sendDmVoiceSignal/dm_voice_* events
// instead of sendGuildSignal/voice_*. Deliberately a separate file/provider
// rather than a generalization of voice-context.tsx: that file is proven
// and in active use for guild voice channels, and duplicating ~500 lines
// here carries far less risk than reworking a shared abstraction under
// both callers at once. Camera + screen-share supported from the start
// (unlike guild voice channels' audio-first rollout) since group DM calls
// are the video-call surface, not a voice-first hangout space.
//
// Mesh join sequence, same shape as voice-context.tsx:
//   1. sendDmVoiceSignal({ type: "dm_voice_join", dm_id })
//   2. server replies with `dm_voice_channel_state` listing who's already
//      in the call — we initiate an offer to each of them.
//   3. `dm_voice_user_joined` for anyone joining after us — they initiate
//      to us, so exactly one offer exists per pair.
//   4. `dm_voice_user_left` tears down just that one peer.

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

export type DmVoicePeerState = {
  stream: MediaStream | null;
  connectionState: string;
};

export type DmVoiceState = {
  dmId: string | null;
  peers: Record<string /* user_id */, DmVoicePeerState>;
  micMuted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  screenSharingPeerIds: string[];
  localStream: MediaStream | null;
};

const IDLE_STATE: DmVoiceState = {
  dmId: null,
  peers: {},
  micMuted: false,
  deafened: false,
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

type DmVoiceContextValue = {
  dmVoice: DmVoiceState;
  joinDmVoice: (dmId: string, withCamera: boolean) => Promise<void>;
  leaveDmVoice: () => void;
  toggleDmMic: () => void;
  toggleDmDeafen: () => void;
  toggleDmCamera: () => Promise<void>;
  toggleDmScreenShare: () => Promise<void>;
};

const DmVoiceContext = createContext<DmVoiceContextValue | null>(null);

type PeerSession = {
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
};

export function DmVoiceProvider({ children }: { children: React.ReactNode }) {
  const { subscribe, sendDmVoiceSignal } = useRealtime();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const [dmVoice, setDmVoice] = useState<DmVoiceState>(IDLE_STATE);

  const dmIdRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Record<string, PeerSession>>({});
  const micMutedRef = useRef(false);
  const cameraOnRef = useRef(false);
  const screenSharingRef = useRef(false);
  const deafenedRef = useRef(false);
  const preDeafenMicMutedRef = useRef(false);

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

  const teardownPeer = useCallback((userId: string) => {
    const session = peersRef.current[userId];
    if (!session) return;
    session.pc.ontrack = null;
    session.pc.onicecandidate = null;
    session.pc.oniceconnectionstatechange = null;
    session.pc.close();
    delete peersRef.current[userId];
    setDmVoice((prev) => {
      const next = { ...prev.peers };
      delete next[userId];
      return { ...prev, peers: next };
    });
  }, []);

  const teardownAll = useCallback(() => {
    for (const userId of Object.keys(peersRef.current)) {
      teardownPeer(userId);
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    dmIdRef.current = null;
    micMutedRef.current = false;
    cameraOnRef.current = false;
    screenSharingRef.current = false;
    deafenedRef.current = false;
    setDmVoice(IDLE_STATE);
  }, [teardownPeer]);

  const buildPeerConnection = useCallback(
    (dmId: string, remoteUserId: string): PeerSession => {
      const pc = new RTCPeerConnection({
        iceServers: parseIceServers(),
        iceTransportPolicy: settingsRef.current.forceTurnRelay ? "relay" : "all",
      });
      const session: PeerSession = { pc, pendingCandidates: [] };
      peersRef.current[remoteUserId] = session;

      setDmVoice((prev) => ({
        ...prev,
        peers: {
          ...prev.peers,
          [remoteUserId]: { stream: null, connectionState: pc.connectionState },
        },
      }));

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          sendDmVoiceSignal({
            type: "dm_voice_ice_candidate",
            dm_id: dmId,
            to: remoteUserId,
            candidate: evt.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (evt) => {
        const [stream] = evt.streams;
        if (deafenedRef.current) evt.track.enabled = false;
        setDmVoice((prev) => ({
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
        setDmVoice((prev) => {
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
    [sendDmVoiceSignal, teardownPeer],
  );

  const flushPendingCandidates = useCallback(async (session: PeerSession) => {
    const queued = session.pendingCandidates;
    session.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await session.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("dm-voice: failed to add queued ICE candidate", e);
      }
    }
  }, []);

  const initiatePeer = useCallback(
    async (dmId: string, remoteUserId: string) => {
      const session = buildPeerConnection(dmId, remoteUserId);
      try {
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        sendDmVoiceSignal({
          type: "dm_voice_offer",
          dm_id: dmId,
          to: remoteUserId,
          sdp: offer as RTCSessionDescriptionInit,
        });
      } catch (e) {
        console.warn("dm-voice: failed to create/send offer", e);
        teardownPeer(remoteUserId);
      }
    },
    [buildPeerConnection, sendDmVoiceSignal, teardownPeer],
  );

  // withCamera: group calls default to starting the camera on join when
  // the user picked "video call" (vs. "voice call") in the UI, unlike
  // guild voice channels which are always audio-first.
  const joinDmVoice = useCallback(
    async (dmId: string, withCamera: boolean) => {
      if (dmIdRef.current) {
        teardownAll();
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(),
          video: withCamera,
        });
        if (settingsRef.current.autoMuteOnJoin) {
          stream.getAudioTracks().forEach((t) => (t.enabled = false));
        }
        localStreamRef.current = stream;
        micMutedRef.current = settingsRef.current.autoMuteOnJoin;
        cameraOnRef.current = withCamera && stream.getVideoTracks().length > 0;
        dmIdRef.current = dmId;
        setDmVoice({
          dmId,
          peers: {},
          micMuted: micMutedRef.current,
          deafened: false,
          cameraOn: cameraOnRef.current,
          screenSharing: false,
          screenSharingPeerIds: [],
          localStream: stream,
        });
        sendDmVoiceSignal({ type: "dm_voice_join", dm_id: dmId });
      } catch (e) {
        console.warn("dm-voice: failed to access mic/camera", e);
        teardownAll();
      }
    },
    [buildAudioConstraints, sendDmVoiceSignal, teardownAll],
  );

  const leaveDmVoice = useCallback(() => {
    const dmId = dmIdRef.current;
    if (!dmId) return;
    sendDmVoiceSignal({ type: "dm_voice_leave", dm_id: dmId });
    teardownAll();
  }, [sendDmVoiceSignal, teardownAll]);

  const toggleDmMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !micMutedRef.current;
    stream.getAudioTracks().forEach((t) => (t.enabled = !nextMuted));
    micMutedRef.current = nextMuted;
    setDmVoice((prev) => ({ ...prev, micMuted: nextMuted }));
  }, []);

  const toggleDmDeafen = useCallback(() => {
    const nextDeafened = !deafenedRef.current;
    deafenedRef.current = nextDeafened;
    for (const session of Object.values(peersRef.current)) {
      for (const receiver of session.pc.getReceivers()) {
        if (receiver.track.kind === "audio") receiver.track.enabled = !nextDeafened;
      }
    }
    if (nextDeafened) {
      preDeafenMicMutedRef.current = micMutedRef.current;
      const stream = localStreamRef.current;
      stream?.getAudioTracks().forEach((t) => (t.enabled = false));
      micMutedRef.current = true;
    } else {
      const stream = localStreamRef.current;
      const restoreMuted = preDeafenMicMutedRef.current;
      stream?.getAudioTracks().forEach((t) => (t.enabled = !restoreMuted));
      micMutedRef.current = restoreMuted;
    }
    setDmVoice((prev) => ({ ...prev, deafened: nextDeafened, micMuted: micMutedRef.current }));
  }, []);

  const renegotiateAllPeers = useCallback(
    async (dmId: string) => {
      for (const [remoteUserId, session] of Object.entries(peersRef.current)) {
        try {
          const offer = await session.pc.createOffer();
          await session.pc.setLocalDescription(offer);
          sendDmVoiceSignal({
            type: "dm_voice_offer",
            dm_id: dmId,
            to: remoteUserId,
            sdp: offer as RTCSessionDescriptionInit,
          });
        } catch (e) {
          console.warn(`dm-voice: failed to renegotiate with ${remoteUserId}`, e);
        }
      }
    },
    [sendDmVoiceSignal],
  );

  const toggleDmCamera = useCallback(async () => {
    const dmId = dmIdRef.current;
    if (!dmId) return;

    if (cameraOnRef.current) {
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
      setDmVoice((prev) => ({ ...prev, cameraOn: false, localStream: localStreamRef.current }));
      await renegotiateAllPeers(dmId);
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
      setDmVoice((prev) => ({ ...prev, cameraOn: true, localStream: localStreamRef.current }));
      await renegotiateAllPeers(dmId);
    } catch (e) {
      console.warn("dm-voice: failed to access camera", e);
    }
  }, [renegotiateAllPeers]);

  const toggleDmScreenShare = useCallback(async () => {
    const dmId = dmIdRef.current;
    if (!dmId) return;

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
      setDmVoice((prev) => ({ ...prev, screenSharing: false, localStream: localStreamRef.current }));
      await renegotiateAllPeers(dmId);
      sendDmVoiceSignal({ type: "dm_voice_screen_share_state", dm_id: dmId, sharing: false });
      return;
    }

    try {
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
      screenTrack.onended = () => {
        void toggleDmScreenShare();
      };
      screenSharingRef.current = true;
      setDmVoice((prev) => ({
        ...prev,
        screenSharing: true,
        cameraOn: false,
        localStream: localStreamRef.current,
      }));
      await renegotiateAllPeers(dmId);
      sendDmVoiceSignal({ type: "dm_voice_screen_share_state", dm_id: dmId, sharing: true });
    } catch (e) {
      console.warn("dm-voice: failed to start screen share", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renegotiateAllPeers]);

  useEffect(() => {
    return subscribe(async (event: RealtimeEvent) => {
      switch (event.type) {
        case "dm_voice_channel_state": {
          if (event.dm_id !== dmIdRef.current) return;
          for (const userId of event.user_ids) {
            if (peersRef.current[userId]) continue;
            void initiatePeer(event.dm_id, userId);
          }
          break;
        }
        case "dm_voice_user_joined": {
          if (event.dm_id !== dmIdRef.current) return;
          break;
        }
        case "dm_voice_user_left": {
          if (event.dm_id !== dmIdRef.current) return;
          teardownPeer(event.user_id);
          setDmVoice((prev) => ({
            ...prev,
            screenSharingPeerIds: prev.screenSharingPeerIds.filter((id) => id !== event.user_id),
          }));
          break;
        }
        case "dm_voice_screen_share_state": {
          if (event.dm_id !== dmIdRef.current) return;
          setDmVoice((prev) => ({
            ...prev,
            screenSharingPeerIds: event.sharing
              ? [...prev.screenSharingPeerIds.filter((id) => id !== event.user_id), event.user_id]
              : prev.screenSharingPeerIds.filter((id) => id !== event.user_id),
          }));
          break;
        }
        case "dm_voice_offer": {
          if (event.dm_id !== dmIdRef.current) return;
          let session = peersRef.current[event.from];
          if (!session) {
            session = buildPeerConnection(event.dm_id, event.from);
          }
          try {
            await session.pc.setRemoteDescription(event.sdp);
            await flushPendingCandidates(session);
            const answer = await session.pc.createAnswer();
            await session.pc.setLocalDescription(answer);
            sendDmVoiceSignal({
              type: "dm_voice_answer",
              dm_id: event.dm_id,
              to: event.from,
              sdp: answer as RTCSessionDescriptionInit,
            });
          } catch (e) {
            console.warn("dm-voice: failed to answer offer", e);
            teardownPeer(event.from);
          }
          break;
        }
        case "dm_voice_answer": {
          if (event.dm_id !== dmIdRef.current) return;
          const session = peersRef.current[event.from];
          if (!session) return;
          try {
            await session.pc.setRemoteDescription(event.sdp);
            await flushPendingCandidates(session);
          } catch (e) {
            console.warn("dm-voice: failed to set remote answer", e);
          }
          break;
        }
        case "dm_voice_ice_candidate": {
          if (event.dm_id !== dmIdRef.current) return;
          const session = peersRef.current[event.from];
          if (!session || !session.pc.remoteDescription) {
            session?.pendingCandidates.push(event.candidate);
            return;
          }
          try {
            await session.pc.addIceCandidate(event.candidate);
          } catch (e) {
            console.warn("dm-voice: failed to add ICE candidate", e);
          }
          break;
        }
        default:
          break;
      }
    });
  }, [subscribe, initiatePeer, buildPeerConnection, flushPendingCandidates, sendDmVoiceSignal, teardownPeer]);

  useEffect(() => {
    return () => {
      for (const session of Object.values(peersRef.current)) {
        session.pc.close();
      }
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <DmVoiceContext.Provider
      value={{
        dmVoice,
        joinDmVoice,
        leaveDmVoice,
        toggleDmMic,
        toggleDmDeafen,
        toggleDmCamera,
        toggleDmScreenShare,
      }}
    >
      {children}
    </DmVoiceContext.Provider>
  );
}

export function useDmVoice() {
  const ctx = useContext(DmVoiceContext);
  if (!ctx) throw new Error("useDmVoice must be used within DmVoiceProvider");
  return ctx;
}
