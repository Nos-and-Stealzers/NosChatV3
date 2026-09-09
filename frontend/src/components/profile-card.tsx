"use client";

// Discord-style clickable profile card: click any avatar anywhere in the
// app (DM list, friends grid, message sender, guild member list, account
// menu) to see a small popover with their banner color, avatar + live
// status dot, username, pronouns, bio, and custom status text. For your
// own avatar, includes inline edit affordances (bio/pronouns/status text/
// accent+banner color swatches) and the presence-mode picker — all wired
// to the real PATCH /me/profile + PUT /me/presence routes via
// presence-context.tsx. For anyone else it's read-only.

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X, ShieldBan, ShieldOff, Copy } from "lucide-react";
import { avatarRamp, initialOf } from "@/lib/utils";
import { usePresence } from "@/lib/presence-context";
import { AvatarWithStatus } from "@/components/status-dot";
import { StatusDot } from "@/components/status-dot";
import type { PresenceMode, PresenceStatus, PublicProfile } from "@/lib/backend-api";
import { adminBanUser, adminUnbanUser } from "@/lib/backend-api";
import { useAuth } from "@clerk/nextjs";
import { useIsStaff } from "@/lib/admin-context";
import { useContextMenuHandler } from "@/lib/context-menu";

const PRESENCE_OPTIONS: { mode: PresenceMode; label: string; dotStatus: PresenceStatus }[] = [
  { mode: "online", label: "Online", dotStatus: "online" },
  { mode: "idle", label: "Idle", dotStatus: "idle" },
  { mode: "dnd", label: "Do Not Disturb", dotStatus: "dnd" },
  { mode: "invisible", label: "Invisible", dotStatus: "offline" },
];

const ACCENT_SWATCHES = ["#F0A868", "#5FD9C4", "#A283EE", "#EE7FAA", "#6FA5EE", "#86D468"];
const BANNER_SWATCHES = ["#1B1F27", "#2A1B1F", "#1B2A1F", "#1F1B2A", "#2A241B", "#1B242A"];

function PresencePicker({ current }: { current: PresenceMode }) {
  const { setPresenceMode } = usePresence();
  const [busy, setBusy] = useState<PresenceMode | null>(null);

  return (
    <div className="space-y-0.5">
      {PRESENCE_OPTIONS.map((opt) => (
        <button
          key={opt.mode}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(opt.mode);
            try {
              await setPresenceMode(opt.mode);
            } finally {
              setBusy(null);
            }
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-[#E8EAED] transition-colors hover:bg-[#1B1F27] disabled:opacity-60"
        >
          <StatusDot status={opt.dotStatus} size="sm" />
          <span className="flex-1">{opt.label}</span>
          {busy === opt.mode ? (
            <Loader2 className="size-3.5 animate-spin text-[#8B93A1]" />
          ) : current === opt.mode ? (
            <Check className="size-3.5 text-[#F0A868]" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function EditableField({
  label,
  value,
  placeholder,
  maxLength,
  multiline = false,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className="group/field block w-full rounded-lg px-2 py-1 text-left transition-colors hover:bg-[#1B1F27]"
      >
        <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#8B93A1]/70">
          {label}
        </p>
        <p className={`text-sm ${value ? "text-[#C7CDD6]" : "text-[#8B93A1]/60 italic"}`}>
          {value || placeholder}
        </p>
      </button>
    );
  }

  return (
    <div className="rounded-lg bg-[#1B1F27] px-2 py-1.5">
      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.15em] text-[#8B93A1]/70">
        {label}
      </p>
      {multiline ? (
        <textarea
          autoFocus
          value={draft}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          className="w-full resize-none rounded-md border border-[#2A2F3A] bg-[#0F1217] px-2 py-1 text-sm text-[#E8EAED] outline-none focus:border-[#F0A868]/50"
        />
      ) : (
        <input
          autoFocus
          value={draft}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full rounded-md border border-[#2A2F3A] bg-[#0F1217] px-2 py-1 text-sm text-[#E8EAED] outline-none focus:border-[#F0A868]/50"
        />
      )}
      <div className="mt-1.5 flex items-center justify-between">
        <span className="font-mono text-[9px] text-[#8B93A1]/60">
          {draft.length}/{maxLength}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="flex size-6 items-center justify-center rounded-md text-[#8B93A1] hover:bg-[#12151B] hover:text-[#E8EAED]"
          >
            <X className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(draft);
                setEditing(false);
              } finally {
                setSaving(false);
              }
            }}
            className="flex size-6 items-center justify-center rounded-md text-[#4ADE80] hover:bg-[#12151B]"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function ColorSwatchRow({
  label,
  swatches,
  current,
  onPick,
}: {
  label: string;
  swatches: string[];
  current: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="px-2 py-1">
      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.15em] text-[#8B93A1]/70">
        {label}
      </p>
      <div className="flex gap-1.5">
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onPick(c)}
            className={`size-5 rounded-full border-2 transition-transform hover:scale-110 ${
              current.toLowerCase() === c.toLowerCase()
                ? "border-white/70"
                : "border-transparent"
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  );
}

const AVATAR_DIMS = {
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-16 w-16 text-2xl",
  xl: "h-20 w-20 text-3xl",
} as const;

// Site-wide clickable avatar: renders an initials-avatar (optionally with a
// live status dot) that, on click, pops open the shared ProfileCard for
// that user. This is the one canonical building block every avatar in the
// app should use — DM list, friend rows, message senders, guild member
// list, voice tiles/rosters, group-DM pickers, account menu — so clicking
// any avatar anywhere always opens the same real profile popover instead of
// each surface re-implementing its own bespoke click handling (or none at
// all). `userId` doubles as the avatarRamp seed so colors stay identical to
// any lingering non-clickable <Avatar seed=userId .../> usages.
export function ClickableAvatar({
  userId,
  label,
  size = "md",
  showStatus = true,
  dotSize,
  anchorClassName = "absolute top-full left-0 mt-2 z-50",
  className = "",
}: {
  userId: string;
  label: string;
  size?: keyof typeof AVATAR_DIMS;
  // Some surfaces (e.g. the local voice tile / call grid) render an avatar
  // for a user whose live status isn't meaningful to show inline — set to
  // false to render a plain avatar with no status-dot overlay.
  showStatus?: boolean;
  dotSize?: "sm" | "md" | "lg";
  anchorClassName?: string;
  className?: string;
}) {
  const { statusOf, ownProfile } = usePresence();
  const [open, setOpen] = useState(false);
  const isSelf = !!ownProfile && userId === ownProfile.id;
  const isStaff = useIsStaff();
  const { getToken } = useAuth();
  const handleContextMenu = useContextMenuHandler();
  const [banBusy, setBanBusy] = useState(false);

  async function handleAdminBan() {
    setBanBusy(true);
    try {
      const token = await getToken();
      if (token) await adminBanUser(token, userId);
    } finally {
      setBanBusy(false);
    }
  }

  async function handleAdminUnban() {
    setBanBusy(true);
    try {
      const token = await getToken();
      if (token) await adminUnbanUser(token, userId);
    } finally {
      setBanBusy(false);
    }
  }

  const avatarEl = (
    <span
      className={`flex flex-none items-center justify-center rounded-full bg-gradient-to-br font-semibold text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.3)_inset] ${AVATAR_DIMS[size]} ${avatarRamp(userId)} ${className}`}
    >
      {initialOf(label)}
    </span>
  );

  return (
    <span className="relative inline-flex flex-none">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onContextMenu={
          isStaff && !isSelf
            ? handleContextMenu(() => [
                { kind: "label" as const, label: `Admin — ${label}` },
                { kind: "item" as const, label: "Copy User ID", icon: Copy, onSelect: () => void navigator.clipboard.writeText(userId) },
                { kind: "separator" as const },
                {
                  kind: "item" as const,
                  label: banBusy ? "Working…" : "Ban from Platform",
                  icon: ShieldBan,
                  danger: true,
                  disabled: banBusy,
                  onSelect: () => void handleAdminBan(),
                },
                {
                  kind: "item" as const,
                  label: banBusy ? "Working…" : "Unban from Platform",
                  icon: ShieldOff,
                  disabled: banBusy,
                  onSelect: () => void handleAdminUnban(),
                },
              ])
            : undefined
        }
        className="rounded-full transition-transform hover:scale-105"
        title={label}
      >
        {showStatus ? (
          <AvatarWithStatus status={statusOf(userId)} dotSize={dotSize ?? (size === "sm" ? "sm" : "md")}>
            {avatarEl}
          </AvatarWithStatus>
        ) : (
          avatarEl
        )}
      </button>
      {open && (
        <ProfileCard
          userId={userId}
          isSelf={isSelf}
          label={label}
          onClose={() => setOpen(false)}
          anchorClassName={anchorClassName}
        />
      )}
    </span>
  );
}

export function ProfileCard({
  userId,
  isSelf,
  label,
  onClose,
  anchorClassName = "",
}: {
  userId: string;
  isSelf: boolean;
  label: string;
  onClose: () => void;
  // Extra positioning classes the caller applies (absolute/top/left etc.) —
  // this component itself is unpositioned so it can be reused inline or
  // popover-style.
  anchorClassName?: string;
}) {
  const { ownProfile, fetchProfile, updateOwnProfile, statusOf } = usePresence();
  const [remote, setRemote] = useState<PublicProfile | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelf) return;
    void fetchProfile(userId).then(setRemote);
  }, [isSelf, userId, fetchProfile]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const profile = isSelf ? ownProfile : remote;
  const status = statusOf(userId);
  const displayName = profile?.username ?? label;
  const accentColor = profile?.accent_color ?? "#F0A868";
  const bannerColor = profile?.banner_color ?? "#1B1F27";

  return (
    <div
      ref={rootRef}
      className={`animate-pop-in z-50 w-72 overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75)] ${anchorClassName}`}
    >
      {/* Banner */}
      <div className="h-16 w-full" style={{ backgroundColor: bannerColor }} />

      {/* Avatar overlapping the banner */}
      <div className="relative px-4">
        <div className="absolute -top-8 flex items-end gap-2">
          <span className="relative inline-flex flex-none">
            <span
              className={`flex size-16 items-center justify-center rounded-full border-4 border-[#1E232C] bg-gradient-to-br text-2xl font-semibold text-[#12151A] ${avatarRamp(userId)}`}
              style={profile ? { backgroundImage: `linear-gradient(135deg, ${accentColor}, ${accentColor}bb)` } : undefined}
            >
              {initialOf(displayName)}
            </span>
            <StatusDot
              status={status}
              size="lg"
              className="absolute right-0.5 bottom-0.5 translate-x-[10%] translate-y-[10%] border-[3px] border-[#1E232C]"
            />
          </span>
        </div>
      </div>

      <div className="px-4 pt-10 pb-4">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-semibold text-[#E8EAED]">{displayName}</h3>
        </div>
        {profile?.pronouns && !isSelf && (
          <p className="text-xs text-[#8B93A1]">{profile.pronouns}</p>
        )}
        {isSelf && (
          <p className="mt-0.5 text-xs capitalize text-[#8B93A1]">
            {status === "offline" && ownProfile?.presence_mode === "invisible"
              ? "Invisible"
              : status}
          </p>
        )}

        {profile?.status_text && (
          <p className="mt-1.5 truncate text-xs text-[#C7CDD6]">💬 {profile.status_text}</p>
        )}

        <div className="my-3 h-px bg-white/[0.06]" />

        {isSelf ? (
          <div className="space-y-1.5">
            <EditableField
              label="Status text"
              value={ownProfile?.status_text ?? ""}
              placeholder="What are you up to?"
              maxLength={128}
              onSave={(v) => updateOwnProfile({ status_text: v })}
            />
            <EditableField
              label="Pronouns"
              value={ownProfile?.pronouns ?? ""}
              placeholder="e.g. she/her"
              maxLength={40}
              onSave={(v) => updateOwnProfile({ pronouns: v })}
            />
            <EditableField
              label="Bio"
              value={ownProfile?.bio ?? ""}
              placeholder="Tell people about yourself…"
              maxLength={190}
              multiline
              onSave={(v) => updateOwnProfile({ bio: v })}
            />
            <ColorSwatchRow
              label="Accent color"
              swatches={ACCENT_SWATCHES}
              current={ownProfile?.accent_color ?? "#F0A868"}
              onPick={(c) => void updateOwnProfile({ accent_color: c })}
            />
            <ColorSwatchRow
              label="Banner color"
              swatches={BANNER_SWATCHES}
              current={ownProfile?.banner_color ?? "#1B1F27"}
              onPick={(c) => void updateOwnProfile({ banner_color: c })}
            />
            <div className="my-1.5 h-px bg-white/[0.06]" />
            <p className="px-2 font-mono text-[9px] uppercase tracking-[0.15em] text-[#8B93A1]/70">
              Presence
            </p>
            <PresencePicker current={ownProfile?.presence_mode ?? "online"} />
          </div>
        ) : (
          <div className="space-y-2">
            {profile?.bio ? (
              <p>
                <span className="block font-mono text-[9px] uppercase tracking-[0.15em] text-[#8B93A1]/70">
                  About
                </span>
                <span className="text-sm leading-relaxed text-[#C7CDD6]">{profile.bio}</span>
              </p>
            ) : (
              <p className="text-xs italic text-[#8B93A1]/60">No bio yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
