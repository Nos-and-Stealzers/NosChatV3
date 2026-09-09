"use client";

// Active/connecting/outgoing-ringing call overlay — a slide-in panel
// anchored to the bottom-right of the main chat panel so it never fully
// hides the conversation underneath, matching chat-app.tsx's layout
// (rail + sidebar + main). Voice-only calls skip the video tiles and show
// avatars instead.

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
} from "lucide-react";
import { useCall } from "@/lib/call-context";
import { useSettings } from "@/lib/settings-context";

function CallAvatar({ label, large }: { label: string; large?: boolean }) {
  const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full bg-gradient-to-br from-[#F3B57E] to-[#EB9A50] font-display italic text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.3)_inset] ${large ? "h-40 w-40 text-6xl" : "h-24 w-24 text-4xl"}`}
    >
      {initial}
    </span>
  );
}

export function CallPanel({ peerLabel }: { peerLabel: string }) {
  const { call, cancelCall, hangUp, toggleMic, toggleCamera, toggleScreenShare } = useCall();
  const { settings } = useSettings();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Elapsed-time counter, ticking only while actually connected — resets
  // whenever a fresh call starts (status leaves "active" then re-enters).
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (call.status !== "active") {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [call.status]);
  function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function handleScreenShareClick() {
    if (
      !call.screenSharing &&
      settings.screenShareConfirmPrompt &&
      !window.confirm("Start sharing your screen with " + (peerLabel || "the other person") + "?")
    ) {
      return;
    }
    void toggleScreenShare();
  }

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = call.localStream;
  }, [call.localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = call.remoteStream;
  }, [call.remoteStream]);

  if (call.status === "idle" || call.status === "ringing-incoming") return null;

  const isVideo = call.callType === "video";
  const statusLabel =
    call.status === "ringing-outgoing"
      ? "Ringing…"
      : call.status === "connecting"
        ? "Connecting…"
        : `In call · ${formatDuration(elapsedSec)}`;

  return (
    <div
      className={`animate-rise-in fixed z-40 overflow-hidden rounded-2xl border border-[#2A2F3A] bg-[#0B0D12] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)] transition-[width,height] duration-200 ${
        expanded
          ? "bottom-4 right-4 top-4 w-[min(64rem,calc(100vw-2rem))]"
          : "bottom-4 right-4 w-[min(22rem,calc(100vw-2rem))]"
      }`}
    >
      <div
        className={`noschat-grain relative flex w-full items-center justify-center bg-[#12151B] ${
          expanded ? "h-[calc(100%-4.25rem)]" : "aspect-video"
        }`}
      >
        <button
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? "Shrink call" : "Expand call"}
          className="absolute right-2 top-2 z-10 flex size-8 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
        {isVideo ? (
          <>
            {/* Remote video fills the tile; falls back to an avatar until a
                remote track actually arrives. */}
            {call.remoteStream ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              <CallAvatar label={peerLabel} large={expanded} />
            )}
            {/* Local self-view, picture-in-picture style, only when camera
                is actually on (screen share replaces this track too, so it
                shows whatever's actually being sent). */}
            {call.localStream && !call.cameraOff && (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={`absolute bottom-2 right-2 rounded-lg border border-[#2A2F3A] object-cover shadow-lg ${expanded ? "h-32 w-48" : "h-16 w-24"}`}
              />
            )}
          </>
        ) : (
          <CallAvatar label={peerLabel} />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#E8EAED]">{peerLabel}</p>
          <p className="text-xs text-[#8B93A1]">
            {call.error ? <span className="text-[#EB5757]">{call.error}</span> : statusLabel}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <button
            onClick={toggleMic}
            title={call.micMuted ? "Unmute" : "Mute"}
            className={`flex size-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0A868]/40 ${
              call.micMuted
                ? "bg-[#EB5757]/15 text-[#EB5757] hover:bg-[#EB5757]/25"
                : "bg-[#1B1F27] text-[#8B93A1] hover:bg-[#242A34] hover:text-[#E8EAED]"
            }`}
          >
            {call.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </button>

          {isVideo && (
            <button
              onClick={toggleCamera}
              title={call.cameraOff ? "Turn camera on" : "Turn camera off"}
              className={`flex size-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0A868]/40 ${
                call.cameraOff
                  ? "bg-[#EB5757]/15 text-[#EB5757] hover:bg-[#EB5757]/25"
                  : "bg-[#1B1F27] text-[#8B93A1] hover:bg-[#242A34] hover:text-[#E8EAED]"
              }`}
            >
              {call.cameraOff ? (
                <CameraOff className="size-4" />
              ) : (
                <Camera className="size-4" />
              )}
            </button>
          )}

          {isVideo && call.status === "active" && (
            <button
              onClick={handleScreenShareClick}
              title={call.screenSharing ? "Stop sharing screen" : "Share screen"}
              className={`flex size-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0A868]/40 ${
                call.screenSharing
                  ? "bg-[#F0A868]/20 text-[#F0A868] hover:bg-[#F0A868]/30"
                  : "bg-[#1B1F27] text-[#8B93A1] hover:bg-[#242A34] hover:text-[#E8EAED]"
              }`}
            >
              {call.screenSharing ? (
                <ScreenShareOff className="size-4" />
              ) : (
                <ScreenShare className="size-4" />
              )}
            </button>
          )}

          <button
            onClick={call.status === "ringing-outgoing" ? cancelCall : hangUp}
            title="Hang up"
            className="flex size-9 items-center justify-center rounded-full bg-[#EB5757]/15 text-[#EB5757] transition-colors hover:bg-[#EB5757]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EB5757]/40"
          >
            <PhoneOff className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-exported so chat-app.tsx's header buttons can share the same icon
// without importing lucide-react's Phone directly for that one spot too.
export { Phone };
