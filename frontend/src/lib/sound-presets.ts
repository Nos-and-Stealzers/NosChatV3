// Built-in notification sound presets, synthesized client-side via the Web
// Audio API rather than shipped as static audio files — there's no asset
// pipeline for that yet, and a few oscillator-based tones are enough to make
// "pick a sound" a real, distinguishable choice. Custom uploads (see
// backend-api.ts) are real audio files played through <audio>/Audio(), not
// synthesized.

export type PresetKey = "chime" | "beep" | "pop" | "marimba" | "alert";

export const MESSAGE_PRESETS: PresetKey[] = ["pop", "beep", "chime", "marimba"];
export const RINGTONE_PRESETS: PresetKey[] = ["chime", "alert", "marimba"];

export const PRESET_LABELS: Record<PresetKey, string> = {
  chime: "Chime",
  beep: "Beep",
  pop: "Pop",
  marimba: "Marimba",
  alert: "Alert",
};

let ctx: AudioContext | null = null;
function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  freq: number,
  startOffset: number,
  duration: number,
  type: OscillatorType,
  peakGain: number,
) {
  const audioCtx = getCtx();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = audioCtx.currentTime + startOffset;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peakGain, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

const PLAYERS: Record<PresetKey, () => void> = {
  pop: () => tone(880, 0, 0.12, "sine", 0.3),
  beep: () => tone(660, 0, 0.15, "square", 0.15),
  chime: () => {
    tone(1046.5, 0, 0.4, "sine", 0.25);
    tone(1318.5, 0.08, 0.4, "sine", 0.2);
  },
  marimba: () => {
    tone(523.25, 0, 0.3, "triangle", 0.3);
    tone(659.25, 0.1, 0.3, "triangle", 0.25);
    tone(783.99, 0.2, 0.35, "triangle", 0.2);
  },
  alert: () => {
    tone(740, 0, 0.2, "sawtooth", 0.2);
    tone(740, 0.25, 0.2, "sawtooth", 0.2);
    tone(740, 0.5, 0.2, "sawtooth", 0.2);
  },
};

export function playPreset(key: string) {
  const player = PLAYERS[key as PresetKey];
  if (player) player();
}
