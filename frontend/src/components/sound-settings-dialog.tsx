"use client";

import { X } from "lucide-react";
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-6 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[#E8EAED]">
            Sound Settings
          </h2>
          <Button size="icon-sm" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {sound.loading && (
          <p className="mb-3 text-xs text-[#8B93A1]">Loading…</p>
        )}
        {sound.error && (
          <p className="mb-3 text-xs text-[#EB5757]">{sound.error}</p>
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

        <div className="my-4 h-px bg-[#2A2F3A]" />

        <SlotEditor
          label="Ringtone"
          presets={RINGTONE_PRESETS}
          current={sound.sounds?.ringtone.preset ?? null}
          hasCustom={sound.sounds?.ringtone.has_custom ?? false}
          onChoose={(p) => void sound.choosePreset("ringtone", p)}
          onUpload={(f) => void sound.uploadCustom("ringtone", f)}
          onPreview={() => void sound.play("ringtone")}
        />

        <p className="mt-5 text-xs text-[#8B93A1]/70">
          Custom uploads override the preset until you pick a preset again.
        </p>
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
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
          {label}
        </p>
        <Button size="sm" variant="ghost" onClick={onPreview}>
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
        <label className="cursor-pointer rounded-lg border border-dashed border-[#2A2F3A] px-3 py-1.5 text-xs text-[#8B93A1] transition-colors hover:border-[#F0A868]/40 hover:text-[#F0A868]">
          {hasCustom ? "Custom uploaded ✓" : "Upload custom…"}
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}
