"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  fetchCustomSoundUrl,
  getSounds,
  setSoundPreset,
  uploadCustomSound,
  type SoundSlot,
  type SoundsView,
} from "@/lib/backend-api";
import { playPreset } from "@/lib/sound-presets";
import { useSettings } from "@/lib/settings-context";

export function useSoundSettings() {
  const { getToken } = useAuth();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const [sounds, setSounds] = useState<SoundsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cache blob URLs for custom clips per slot so we don't re-fetch on every
  // play — invalidated whenever that slot's setting changes.
  const customUrlCache = useRef<Partial<Record<SoundSlot, string>>>({});

  const refresh = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      setSounds(await getSounds(token));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sound settings");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const invalidateCache = (slot: SoundSlot) => {
    const existing = customUrlCache.current[slot];
    if (existing) URL.revokeObjectURL(existing);
    delete customUrlCache.current[slot];
  };

  const choosePreset = useCallback(
    async (slot: SoundSlot, preset: string) => {
      const token = await getToken();
      if (!token) return;
      await setSoundPreset(token, slot, preset);
      invalidateCache(slot);
      await refresh();
    },
    [getToken, refresh],
  );

  const uploadCustom = useCallback(
    async (slot: SoundSlot, file: File) => {
      const token = await getToken();
      if (!token) return;
      await uploadCustomSound(token, slot, file);
      invalidateCache(slot);
      await refresh();
    },
    [getToken, refresh],
  );

  const play = useCallback(
    async (slot: SoundSlot) => {
      const s = settingsRef.current;
      if (s.muteAll) return;
      if (slot === "message" && !s.notifyNewMessage) return;
      if (slot === "ringtone" && !s.notifyIncomingCall) return;
      const volume = (slot === "ringtone" ? s.ringtoneVolume : s.notificationVolume) / 100;

      const slotSettings = sounds?.[slot];
      if (slotSettings?.has_custom) {
        try {
          let url = customUrlCache.current[slot];
          if (!url) {
            const token = await getToken();
            if (!token) return;
            url = await fetchCustomSoundUrl(token, slot);
            customUrlCache.current[slot] = url;
          }
          const audio = new Audio(url);
          audio.volume = Math.min(1, Math.max(0, volume));
          void audio.play();
          return;
        } catch {
          // fall through to preset/default below
        }
      }
      playPreset(slotSettings?.preset ?? (slot === "message" ? "pop" : "chime"), volume);
    },
    [sounds, getToken],
  );

  return { sounds, loading, error, choosePreset, uploadCustom, play, refresh };
}
