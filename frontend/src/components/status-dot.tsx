// Discord-style presence status dot. Real states only — status is always
// derived server-side from actual live WebSocket connections layered with
// the user's chosen presence_mode override (see profiles.rs). Rendered as a
// small ring-bordered dot overlaid on the bottom-right corner of an avatar,
// same visual grammar Discord uses.

import type { PresenceStatus } from "@/lib/backend-api";

const STATUS_COLOR: Record<PresenceStatus, string> = {
  online: "bg-[#4ADE80]",
  idle: "bg-[#F0C868]",
  dnd: "bg-[#EB5757]",
  offline: "bg-[#6B7280]",
};

const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: "Online",
  idle: "Idle",
  dnd: "Do Not Disturb",
  offline: "Offline",
};

const SIZE_CLASSES = {
  sm: "h-2 w-2 border-[1.5px]",
  md: "h-2.5 w-2.5 border-2",
  lg: "h-3.5 w-3.5 border-2",
} as const;

export function StatusDot({
  status,
  size = "md",
  className = "",
}: {
  status: PresenceStatus;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  return (
    <span
      title={STATUS_LABEL[status]}
      className={`inline-block flex-none rounded-full border-[#0B0D12] ${STATUS_COLOR[status]} ${SIZE_CLASSES[size]} ${
        status === "online" ? "animate-status-pulse" : ""
      } ${className}`}
    />
  );
}

// Wraps an avatar element with a bottom-right-anchored status dot, matching
// Discord's overlay placement. `avatarSizeClass` controls the dot's offset
// so it sits correctly against sm/md/lg avatars.
export function AvatarWithStatus({
  children,
  status,
  dotSize = "md",
}: {
  children: React.ReactNode;
  status: PresenceStatus;
  dotSize?: keyof typeof SIZE_CLASSES;
}) {
  return (
    <span className="relative inline-flex flex-none">
      {children}
      <StatusDot
        status={status}
        size={dotSize}
        className="absolute -bottom-0 -right-0 translate-x-[15%] translate-y-[15%]"
      />
    </span>
  );
}

export { STATUS_COLOR, STATUS_LABEL };
