"use client";

// Floating panel for an active GROUP DM voice/video call — the N-peer
// analogue of call-panel.tsx's compact 1:1 UI, using dm-voice-context.tsx's
// mesh state instead of call-context.tsx's single-peer state. Rendered at
// chat-app.tsx's top level (same as CallPanel) so both the UI and the
// underlying WebRTC connections survive navigating anywhere else in the
// app — different DM, a guild, a game, settings, whatever's rendered
// underneath never unmounts this or the DmVoiceProvider above it.
//
// Sized to match Discord's actual floating-call behavior: a small pill by
// default, expanding only to a capped, modest tile grid — never a large
// fraction of the screen.

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Headphones, Video, VideoOff, ScreenShare, PhoneOff, Users, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDmVoice } from "@/lib/dm-voice-context";

function GroupCallTile({
  label,
  stream,
  isLocal = false,
  micMuted = false,
  deafened = false,
}: {
  label: string;
  stream: MediaStream | null | undefined;
  isLocal?: boolean;
  micMuted?: boolean;
  deafened?: boolean;
}) {
  const hasVideo = !!stream?.getVideoTracks().length;
  return (
    <div className="relative flex aspect-video h-20 flex-col items-center justify-center overflow-hidden rounded-lg border border-[#2A2F3A] bg-[#12151B]">
      {hasVideo && stream ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- group call video, no captions applicable
        <video
          autoPlay
          playsInline
          muted={isLocal}
          className="absolute inset-0 h-full w-full object-cover"
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
        />
      ) : (
        <div className="flex size-8 items-center justify-center rounded-full bg-[#1E232C] text-xs font-semibold text-[#E8EAED]">
          {label.slice(0, 1).toUpperCase()}
        </div>
      )}
      {stream && !isLocal && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- remote voice audio, no captions applicable
        <audio
          autoPlay
          muted={deafened}
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
        />
      )}
      <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 backdrop-blur-sm">
        {micMuted ? (
          <MicOff className="size-2.5 flex-none text-[#EB5757]" />
        ) : (
          <Mic className="size-2.5 flex-none text-[#8B93A1]" />
        )}
        <span className="max-w-[5rem] truncate text-[9px] font-medium text-[#E8EAED]">{label}</span>
      </div>
    </div>
  );
}

export function DmGroupCallPanel({
  dmId,
  nameFor,
  myLabel,
}: {
  dmId: string | null;
  nameFor: (userId: string) => string;
  myLabel: string;
}) {
  const { dmVoice, leaveDmVoice, toggleDmMic, toggleDmDeafen, toggleDmCamera, toggleDmScreenShare } = useDmVoice();
  // Compact by default — matches Discord's small floating call bar rather
  // than a large always-open tile grid.
  const [showTiles, setShowTiles] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localVideoRef.current && dmVoice.localStream) {
      localVideoRef.current.srcObject = dmVoice.localStream;
    }
  }, [dmVoice.localStream]);

  // Only render while actually in a call for THIS dm (or any group call —
  // the panel is global so it stays visible while browsing other DMs).
  if (!dmVoice.dmId) return null;

  const peerIds = Object.keys(dmVoice.peers);

  return (
    <div className="animate-rise-in fixed bottom-4 right-[19.5rem] z-40 w-72 overflow-hidden rounded-2xl border border-[#2A2F3A] bg-[#0F1217] shadow-2xl">
      {showTiles && (
        // Capped-size grid — at most 2 columns of small fixed-height
        // tiles with internal scroll for larger calls, never growing to
        // dominate the screen regardless of participant count.
        <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto p-2">
          <GroupCallTile label={myLabel} stream={dmVoice.localStream} isLocal micMuted={dmVoice.micMuted} />
          {peerIds.map((userId) => (
            <GroupCallTile
              key={userId}
              label={nameFor(userId)}
              stream={dmVoice.peers[userId]?.stream}
              micMuted={dmVoice.peers[userId]?.micMuted ?? false}
              deafened={dmVoice.deafened}
            />
          ))}
        </div>
      )}

      <button
        onClick={() => setShowTiles((v) => !v)}
        className="flex w-full items-center gap-2 border-t border-[#1D2129] px-3 py-2 text-left first:border-t-0"
      >
        <Users className="size-3.5 flex-none text-[#8B93A1]" />
        <span className="flex-1 truncate text-xs font-semibold text-[#E8EAED]">
          Group call · {peerIds.length + 1} {peerIds.length === 0 ? "person" : "people"}
        </span>
        {showTiles ? (
          <ChevronDown className="size-3.5 flex-none text-[#8B93A1]" />
        ) : (
          <ChevronUp className="size-3.5 flex-none text-[#8B93A1]" />
        )}
      </button>

      <div className="flex items-center justify-center gap-1.5 border-t border-[#1D2129] px-3 py-2">
        <Button size="icon-sm" variant="ghost" onClick={toggleDmMic} title={dmVoice.micMuted ? "Unmute" : "Mute"}>
          {dmVoice.micMuted ? <MicOff className="size-4 text-[#EB5757]" /> : <Mic className="size-4" />}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={toggleDmDeafen} title={dmVoice.deafened ? "Undeafen" : "Deafen"}>
          <Headphones className={`size-4 ${dmVoice.deafened ? "text-[#EB5757]" : ""}`} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void toggleDmCamera()}
          title={dmVoice.cameraOn ? "Turn Camera Off" : "Turn Camera On"}
        >
          {dmVoice.cameraOn ? <Video className="size-4 text-[#F0A868]" /> : <VideoOff className="size-4" />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void toggleDmScreenShare()}
          title={dmVoice.screenSharing ? "Stop Screen Share" : "Share Screen"}
        >
          <ScreenShare className={`size-4 ${dmVoice.screenSharing ? "text-[#4ADE80]" : ""}`} />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={leaveDmVoice} title="Leave Call">
          <PhoneOff className="size-4 text-[#EB5757]" />
        </Button>
      </div>
    </div>
  );
}
