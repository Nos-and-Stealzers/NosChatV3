"use client";

// Discord-style reaction pills + "add reaction" hover trigger. Generic over
// a small curated emoji set (no picker library dependency) — matches the
// existing QUICK_EMOJIS pattern already used for the composer in
// chat-app.tsx. Toggling a pill or picking from the popover both call the
// same `onToggle(emoji)`, mirroring the backend's toggle-react/unreact
// semantics on POST .../reactions.

import { useEffect, useRef, useState } from "react";
import { SmilePlus } from "lucide-react";
import type { ReactionSummary } from "@/lib/backend-api";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

export function ReactionBar({
  reactions,
  onToggle,
  alwaysShowAdd = false,
}: {
  reactions: ReactionSummary[] | undefined;
  onToggle: (emoji: string) => void;
  // When true the add-reaction button is always visible instead of only on
  // hover of the parent (parent should set `group/msg` + this prop true on
  // touch/mobile where hover doesn't exist).
  alwaysShowAdd?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  const hasReactions = reactions && reactions.length > 0;
  if (!hasReactions && !pickerOpen && !alwaysShowAdd) {
    // Nothing to show yet — the parent's hover state reveals the trigger
    // via its own opacity classes wrapping this component; still render the
    // trigger so hover works, just visually hidden until hovered.
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions?.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onToggle(r.emoji)}
          title={r.reacted_by_me ? "Remove your reaction" : "React"}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${
            r.reacted_by_me
              ? "border-[#F0A868]/50 bg-[#F0A868]/15 text-[#F0A868]"
              : "border-[#2A2F3A] bg-[#12151B] text-[#C7CDD6] hover:border-[#3A4050] hover:bg-[#1B1F27]"
          }`}
        >
          <span className="leading-none">{r.emoji}</span>
          <span className="font-mono text-[10px] leading-none">{r.count}</span>
        </button>
      ))}

      <div ref={pickerRef} className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          title="Add reaction"
          className={`flex size-6 items-center justify-center rounded-full text-[#8B93A1] transition-all hover:bg-[#1B1F27] hover:text-[#E8EAED] ${
            hasReactions || alwaysShowAdd
              ? "opacity-100"
              : "opacity-0 group-hover/msg:opacity-100"
          } ${pickerOpen ? "!opacity-100 bg-[#1B1F27] text-[#F0A868]" : ""}`}
        >
          <SmilePlus className="size-3.5" />
        </button>
        {pickerOpen && (
          <div className="animate-pop-in absolute bottom-8 left-0 z-30 flex gap-0.5 rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-1.5 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_16px_40px_-15px_rgba(0,0,0,0.7)]">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onToggle(emoji);
                  setPickerOpen(false);
                }}
                className="flex size-7 items-center justify-center rounded-md text-base transition-colors hover:bg-[#1B1F27]"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
