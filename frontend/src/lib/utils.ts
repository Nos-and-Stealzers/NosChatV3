import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Deterministic per-user color so avatars are visually distinct instead of
// every initial sitting in the same gray circle. Picked from a small warm/
// cool set that stays legible against the dark panels rather than random
// hues that could clash.
const AVATAR_RAMPS = [
  "from-[#F0A868] to-[#EB7A50]",
  "from-[#5FD9C4] to-[#3FA88F]",
  "from-[#8FA6F0] to-[#6B7FE0]",
  "from-[#E88FD0] to-[#C15FB0]",
  "from-[#F0C868] to-[#E0955F]",
  "from-[#7ED0E8] to-[#4FA0C8]",
] as const;

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function avatarRamp(seed: string): string {
  return AVATAR_RAMPS[hashSeed(seed || "?") % AVATAR_RAMPS.length];
}

export function initialOf(label: string): string {
  return (label.trim()[0] ?? "?").toUpperCase();
}
