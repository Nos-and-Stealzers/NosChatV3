"use client";

// Active/connecting/outgoing-ringing call overlay. Redesigned to match
// Discord's actual behavior: a small persistent pill bar docked
// bottom-right that never covers a meaningful part of the screen. Video
// (when present) shows as a compact preview tile above the control bar —
// capped at a modest fixed size, not a scaling "expanded" mode that used
// to balloon up to 64rem wide / near-full height. This panel lives at
// chat-app.tsx's top level (outside any conditionally-rendered view), so
// it keeps rendering — and the call itself keeps running, since its state
// lives in call-context.tsx above ChatApp in the provider tree — no
// matter what page/DM/guild/game view is currently open underneath it.

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  ChevronDown,
  ChevronUp,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
} from "lucide-react";
import { useCall } from "@/lib/call-context";
import { useSettings } from "@/lib/settings-context";

function CallAvatar({ label, size = 40 }: { label: string; size?: number }) {
  const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      style={{ height: size, width: size, fontSize: size * 0.4 }}
      className="flex flex-none items-center justify-center rounded-full bg-gradient-to-br from-[#F3B57E] to-[#EB9A50] font-display italic text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.3)_inset]"
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
  // Video preview is collapsed by default — just the compact control pill
  // shows. Expanding reveals a small (not screen-covering) video tile.
  const [showVideo, setShowVideo] = useState(true);
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
    <div className="animate-rise-in fixed bottom-4 right-4 z-40 w-72 overflow-hidden rounded-2xl border border-[#2A2F3A] bg-[#0B0D12] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]">
      {/* Compact video preview — small, fixed-height tile, never scales up
          to cover the screen. Hidden entirely for voice-only calls. */}
      {isVideo && showVideo && (
        <div className="noschat-grain relative flex h-40 w-full items-center justify-center bg-[#12151B]">
          {call.remoteStream ? (
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="h-full w-full object-cover"
            />
          ) : (
            <CallAvatar label={peerLabel} size={64} />
          )}
          {call.localStream && !call.cameraOff && (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute bottom-1.5 right-1.5 h-12 w-20 rounded-md border border-[#2A2F3A] object-cover shadow-lg"
            />
          )}
        </div>
      )}

      {/* Compact pill bar — always present, this is the "never covers the
          screen" baseline. Matches Discord's persistent call bar. */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        {!isVideo && <CallAvatar label={peerLabel} size={32} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-[#E8EAED]">{peerLabel}</p>
          <p className="truncate text-[11px] text-[#8B93A1]">
            {call.error ? <span className="text-[#EB5757]">{call.error}</span> : statusLabel}
          </p>
        </div>
        {isVideo && (
          <button
            onClick={() => setShowVideo((v) => !v)}
            title={showVideo ? "Hide preview" : "Show preview"}
            className="flex size-7 flex-none items-center justify-center rounded-full text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
          >
            {showVideo ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        )}
      </div>

      <div className="flex items-center justify-center gap-1.5 border-t border-[#1D2129] px-3 py-2">
        <button
          onClick={toggleMic}
          title={call.micMuted ? "Unmute" : "Mute"}
          className={`flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0A868]/40 ${
            call.micMuted
              ? "bg-[#EB5757]/15 text-[#EB5757] hover:bg-[#EB5757]/25"
              : "bg-[#1B1F27] text-[#8B93A1] hover:bg-[#242A34] hover:text-[#E8EAED]"
          }`}
        >
          {call.micMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
        </button>

        {isVideo && (
          <button
            onClick={toggleCamera}
            title={call.cameraOff ? "Turn camera on" : "Turn camera off"}
            className={`flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0A868]/40 ${
              call.cameraOff
                ? "bg-[#EB5757]/15 text-[#EB5757] hover:bg-[#EB5757]/25"
                : "bg-[#1B1F27] text-[#8B93A1] hover:bg-[#242A34] hover:text-[#E8EAED]"
            }`}
          >
            {call.cameraOff ? <CameraOff className="size-3.5" /> : <Camera className="size-3.5" />}
          </button>
        )}

        {isVideo && call.status === "active" && (
          <button
            onClick={handleScreenShareClick}
            title={call.screenSharing ? "Stop sharing screen" : "Share screen"}
            className={`flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0A868]/40 ${
              call.screenSharing
                ? "bg-[#F0A868]/20 text-[#F0A868] hover:bg-[#F0A868]/30"
                : "bg-[#1B1F27] text-[#8B93A1] hover:bg-[#242A34] hover:text-[#E8EAED]"
            }`}
          >
            {call.screenSharing ? (
              <ScreenShareOff className="size-3.5" />
            ) : (
              <ScreenShare className="size-3.5" />
            )}
          </button>
        )}

        <button
          onClick={call.status === "ringing-outgoing" ? cancelCall : hangUp}
          title="Hang up"
          className="flex size-8 items-center justify-center rounded-full bg-[#EB5757]/15 text-[#EB5757] transition-colors hover:bg-[#EB5757]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EB5757]/40"
        >
          <PhoneOff className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// Re-exported so chat-app.tsx's header buttons can share the same icon
// without importing lucide-react's Phone directly for that one spot too.
export { Phone };
