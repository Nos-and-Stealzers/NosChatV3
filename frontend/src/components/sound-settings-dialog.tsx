"use client";

import { useState } from "react";
import { Check, Play, Upload, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MESSAGE_PRESETS,
  RINGTONE_PRESETS,
  PRESET_LABELS,
  type PresetKey,
} from "@/lib/sound-presets";
import type { SoundSlot, SoundsView } from "@/lib/backend-api";

type SoundHook = {
  sounds: SoundsView | null;
  loading: boolean;
  error: string | null;
  choosePreset: (slot: SoundSlot, preset: string) => Promise<void>;
  uploadCustom: (slot: SoundSlot, file: File) => Promise<void>;
  play: (slot: SoundSlot) => Promise<void>;
};

export function SoundSettingsDialog({
  open,
  onClose,
  sound,
}: {
  open: boolean;
  onClose: () => void;
  sound: SoundHook;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain animate-rise-in relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-6 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75),0_10px_30px_-10px_rgba(240,168,104,0.10)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent"
      >
        <div className="relative z-[1] mb-5 flex items-start justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#8B93A1]/70">
              Preferences
            </p>
            <h2 className="flex items-center gap-2 font-display text-2xl italic text-[#E8EAED]">
              <Volume2 className="size-5 not-italic text-[#F0A868]" />
              Sound
            </h2>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close">
            <X className="size-4" />
          </Button>
        </div>

        <div className="relative z-[1] space-y-5">
          {sound.loading && (
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
              Loading…
            </p>
          )}
          {sound.error && (
            <p className="rounded-lg border border-[#EB5757]/25 bg-[#EB5757]/10 px-3 py-2 text-xs text-[#EB5757]">
              {sound.error}
            </p>
          )}

          <SlotEditor
            label="Message Beep"
            presets={MESSAGE_PRESETS}
            current={sound.sounds?.message.preset ?? null}
            hasCustom={sound.sounds?.message.has_custom ?? false}
            onChoose={(p) => void sound.choosePreset("message", p)}
            onUpload={(f) => void sound.uploadCustom("message", f)}
            onPreview={() => void sound.play("message")}
          />

          <div className="h-px bg-gradient-to-r from-transparent via-[#2A2F3A] to-transparent" />

          <SlotEditor
            label="Ringtone"
            presets={RINGTONE_PRESETS}
            current={sound.sounds?.ringtone.preset ?? null}
            hasCustom={sound.sounds?.ringtone.has_custom ?? false}
            onChoose={(p) => void sound.choosePreset("ringtone", p)}
            onUpload={(f) => void sound.uploadCustom("ringtone", f)}
            onPreview={() => void sound.play("ringtone")}
          />

          <p className="text-xs leading-relaxed text-[#8B93A1]/70">
            Custom uploads override the preset until you pick a preset again.
          </p>
        </div>
      </div>
    </div>
  );
}

function SlotEditor({
  label,
  presets,
  current,
  hasCustom,
  onChoose,
  onUpload,
  onPreview,
}: {
  label: string;
  presets: PresetKey[];
  current: string | null;
  hasCustom: boolean;
  onChoose: (preset: string) => void;
  onUpload: (file: File) => void;
  onPreview: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
          {label}
        </p>
        <Button size="sm" variant="ghost" onClick={onPreview} className="gap-1.5">
          <Play className="size-3" />
          Preview
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => onChoose(p)}
            data-active={!hasCustom && current === p}
            className="rounded-lg border border-[#2A2F3A] bg-[#12151A] px-3 py-1.5 text-xs text-[#8B93A1] transition-colors hover:border-[#F0A868]/40 hover:text-[#E8EAED] data-[active=true]:border-[#F0A868] data-[active=true]:bg-[#F0A868]/10 data-[active=true]:text-[#F0A868]"
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
        <label
          data-active={hasCustom}
          className="group flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-[#2A2F3A] px-3 py-1.5 text-xs text-[#8B93A1] transition-colors hover:border-[#F0A868]/40 hover:text-[#F0A868] data-[active=true]:border-solid data-[active=true]:border-[#F0A868] data-[active=true]:bg-[#F0A868]/10 data-[active=true]:text-[#F0A868]"
        >
          {hasCustom ? (
            <>
              <Check className="size-3" /> Custom uploaded
            </>
          ) : (
            <>
              <Upload className="size-3" />
              {uploading ? "Uploading…" : "Upload custom…"}
            </>
          )}
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
