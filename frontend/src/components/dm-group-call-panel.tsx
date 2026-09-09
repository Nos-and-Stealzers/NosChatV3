"use client";

// Floating panel for an active GROUP DM voice/video call — the N-peer
// analogue of call-panel.tsx's 1:1 UI, using dm-voice-context.tsx's mesh
// state instead of call-context.tsx's single-peer state. Rendered at the
// chat-app.tsx top level (same as CallPanel) so it survives navigating
// between DMs while a call is active.

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Headphones, Video, VideoOff, ScreenShare, PhoneOff, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDmVoice } from "@/lib/dm-voice-context";

function GroupCallTile({
  seed,
  label,
  stream,
  isLocal = false,
  micMuted = false,
  deafened = false,
}: {
  seed: string;
  label: string;
  stream: MediaStream | null | undefined;
  isLocal?: boolean;
  micMuted?: boolean;
  deafened?: boolean;
}) {
  const hasVideo = !!stream?.getVideoTracks().length;
  return (
    <div className="relative flex aspect-video min-h-[120px] flex-col items-center justify-center overflow-hidden rounded-xl border border-[#2A2F3A] bg-[#12151B]">
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
        <div className="flex size-14 items-center justify-center rounded-full bg-[#1E232C] text-lg font-semibold text-[#E8EAED]">
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
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 backdrop-blur-sm">
        {micMuted ? (
          <MicOff className="size-3 flex-none text-[#EB5757]" />
        ) : (
          <Mic className="size-3 flex-none text-[#8B93A1]" />
        )}
        <span className="max-w-[8rem] truncate text-[11px] font-medium text-[#E8EAED]">{label}</span>
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
  const [expanded, setExpanded] = useState(true);
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
    <div
      className={`fixed bottom-4 right-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-[#2A2F3A] bg-[#0F1217] shadow-2xl transition-all ${
        expanded ? "w-[420px]" : "w-64"
      }`}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 border-b border-[#1D2129] px-3 py-2 text-left"
      >
        <Users className="size-4 text-[#8B93A1]" />
        <span className="flex-1 truncate text-xs font-semibold text-[#E8EAED]">
          Group call · {peerIds.length + 1} {peerIds.length === 0 ? "person" : "people"}
        </span>
      </button>

      {expanded && (
        <div className="grid grid-cols-2 gap-1.5 p-2">
          <GroupCallTile
            seed="me"
            label={myLabel}
            stream={dmVoice.localStream}
            isLocal
            micMuted={dmVoice.micMuted}
          />
          {peerIds.map((userId) => (
            <GroupCallTile
              key={userId}
              seed={userId}
              label={nameFor(userId)}
              stream={dmVoice.peers[userId]?.stream}
              micMuted={dmVoice.peers[userId]?.connectionState !== "connected"}
              deafened={dmVoice.deafened}
            />
          ))}
        </div>
      )}

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
