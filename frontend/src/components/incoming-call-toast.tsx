"use client";

// Incoming-call banner: shows regardless of which view is currently open
// (friends list or any DM) since it's rendered once at the top level in
// chat-app.tsx, not scoped to the DM view. Visually matches the app's
// existing amber/near-black language and reuses the rise-in keyframe
// already defined in globals.css.

import { Phone, PhoneOff, Video } from "lucide-react";
import { useCall } from "@/lib/call-context";

function Avatar({ seed, label }: { seed: string; label: string }) {
  // Mirrors chat-app.tsx's Avatar component's visual language without a
  // cross-import — kept intentionally tiny/self-contained here since this
  // toast can render outside the DM view where the "active" avatar helpers
  // don't have context.
  const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      key={seed}
      className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-gradient-to-br from-[#F3B57E] to-[#EB9A50] font-semibold text-[#12151A] text-lg shadow-[0_1px_0_rgba(255,255,255,0.3)_inset]"
    >
      {initial}
    </span>
  );
}

export function IncomingCallToast({
  peerLabel,
}: {
  // Resolved by the caller (chat-app.tsx) from friends/DMs data, since
  // call-context.tsx only knows the peer's raw user id, not their display
  // name/username.
  peerLabel: string;
}) {
  const { call, acceptCall, rejectCall } = useCall();

  if (call.status !== "ringing-incoming") return null;

  return (
    <div className="animate-rise-in fixed left-1/2 top-4 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2">
      <div className="noschat-grain flex items-center gap-3 rounded-2xl border border-[#2A2F3A] bg-[#12151B]/95 p-3 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.6)] backdrop-blur">
        <Avatar seed={call.peerUserId ?? peerLabel} label={peerLabel} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#E8EAED]">{peerLabel}</p>
          <p className="flex items-center gap-1 text-xs text-[#F0A868]">
            {call.callType === "video" ? (
              <Video className="size-3.5" />
            ) : (
              <Phone className="size-3.5" />
            )}
            Incoming {call.callType === "video" ? "video call" : "voice call"}…
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            onClick={() => void rejectCall()}
            title="Decline"
            className="flex size-10 items-center justify-center rounded-full bg-[#EB5757]/15 text-[#EB5757] transition-colors hover:bg-[#EB5757]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EB5757]/40"
          >
            <PhoneOff className="size-4" />
          </button>
          <button
            onClick={() => void acceptCall()}
            title="Accept"
            className="flex size-10 items-center justify-center rounded-full bg-[#4ADE80]/15 text-[#4ADE80] transition-colors hover:bg-[#4ADE80]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4ADE80]/40"
          >
            <Phone className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
