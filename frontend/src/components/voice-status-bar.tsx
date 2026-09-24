"use client";

// Persistent "Voice Connected" bar — surfaces guild voice channel
// membership no matter what page/DM/guild/game the user has navigated to,
// matching Discord's bottom-left connected-voice-channel indicator. Before
// this existed, joining a voice channel then browsing away (a DM, a
// different guild, settings) left the connection running with zero UI to
// see it or leave it — the mic stayed hot with no visible way back short
// of returning to that exact channel. Rendered at chat-app.tsx's top
// level, same tier as CallPanel/DmGroupCallPanel, so it survives
// navigation for the same reason they do: it reads state from
// VoiceProvider, which lives above ChatApp in the provider tree and never
// unmounts on route/view changes.

import { Mic, MicOff, Headphones, PhoneOff, Volume2 } from "lucide-react";
import { useVoice } from "@/lib/voice-context";

export function VoiceStatusBar({
  channelName,
  guildName,
  onReturn,
}: {
  channelName: string | null;
  guildName: string | null;
  onReturn: () => void;
}) {
  const { voice, leaveVoiceChannel, toggleMic, toggleDeafen } = useVoice();

  if (!voice.channelId) return null;

  return (
    <div className="animate-rise-in fixed bottom-4 left-[4.75rem] z-40 flex w-60 items-center gap-2 overflow-hidden rounded-xl border border-[#2A2F3A] bg-[#0F1217] px-2.5 py-2 shadow-2xl md:left-[5.5rem]">
      <Volume2 className="size-4 flex-none text-[#4ADE80]" />
      <button onClick={onReturn} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[11px] font-semibold text-[#4ADE80]">Voice Connected</p>
        <p className="truncate text-[10px] text-[#8B93A1]">
          {channelName ?? "Voice channel"}{guildName ? ` · ${guildName}` : ""}
        </p>
      </button>
      <div className="flex flex-none items-center gap-1">
        <button
          onClick={toggleMic}
          title={voice.micMuted ? "Unmute" : "Mute"}
          className={`flex size-7 items-center justify-center rounded-full transition-colors ${
            voice.micMuted ? "bg-[#EB5757]/15 text-[#EB5757]" : "text-[#8B93A1] hover:bg-[#1B1F27] hover:text-[#E8EAED]"
          }`}
        >
          {voice.micMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
        </button>
        <button
          onClick={toggleDeafen}
          title={voice.deafened ? "Undeafen" : "Deafen"}
          className={`flex size-7 items-center justify-center rounded-full transition-colors ${
            voice.deafened ? "bg-[#EB5757]/15 text-[#EB5757]" : "text-[#8B93A1] hover:bg-[#1B1F27] hover:text-[#E8EAED]"
          }`}
        >
          <Headphones className="size-3.5" />
        </button>
        <button
          onClick={leaveVoiceChannel}
          title="Disconnect"
          className="flex size-7 items-center justify-center rounded-full text-[#EB5757] transition-colors hover:bg-[#EB5757]/15"
        >
          <PhoneOff className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
