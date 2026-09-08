"use client";

// Extends the existing 72px rail in chat-app.tsx with a horizontal divider
// and one circular icon button per guild the user is in, plus a '+' button
// to open the create/join modal. Deliberately NOT a standalone rail — it's
// rendered *inside* chat-app.tsx's existing rail <div>, right after the
// NosChat/DM button + SignalDot block, so there's only ever one rail in the
// DOM.

import { Plus } from "lucide-react";
import { useState } from "react";
import { guildIconUrl, type Guild } from "@/lib/backend-api";

function guildInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

function GuildIcon({
  guild,
  active,
  compact,
  hasUnread,
  onClick,
}: {
  guild: Guild;
  active: boolean;
  compact: boolean;
  hasUnread: boolean;
  onClick: () => void;
}) {
  // Every guild is tried as an image first (cheap 404 if none is set —
  // no extra "does this guild have an icon" round trip needed), falling
  // back to the color-swatch initial on load failure. Reset per guild id
  // so switching to a different guild with the same img element re-tries
  // its own image instead of staying stuck on the previous 404 state.
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button
      onClick={onClick}
      data-active={active}
      title={guild.name}
      className={`group relative flex flex-none items-center justify-center overflow-hidden rounded-full font-display text-base text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset] transition-all duration-200 hover:rounded-xl data-[active=true]:rounded-xl ${compact ? "h-10 w-10" : "h-12 w-12"}`}
      style={{ backgroundColor: guild.icon_color }}
    >
      {!imgFailed && (
        // eslint-disable-next-line @next/next/no-img-element -- backend-hosted image, next/image config not worth it for a 2MB-cap inline blob
        <img
          key={guild.id}
          src={guildIconUrl(guild.id)}
          alt=""
          onError={() => setImgFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {imgFailed && guildInitial(guild.name)}
      <span
        className={`pointer-events-none absolute -left-3 rounded-r-full bg-white transition-all duration-150 ${
          active
            ? "h-5 w-1 opacity-100"
            : "h-2 w-1 opacity-0 group-hover:h-2.5 group-hover:opacity-70"
        }`}
      />
      {hasUnread && !active && (
        <span className="animate-badge-pop pointer-events-none absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-[#0B0D12] bg-[#EB5757]" />
      )}
    </button>
  );
}

export function GuildRail({
  guilds,
  activeGuildId,
  compact,
  unreadGuildIds,
  onSelectGuild,
  onOpenCreateJoin,
}: {
  guilds: Guild[];
  activeGuildId: string | null;
  compact: boolean;
  unreadGuildIds?: Set<string>;
  onSelectGuild: (guildId: string) => void;
  onOpenCreateJoin: () => void;
}) {
  return (
    <>
      <div className="my-1.5 h-px w-8 flex-none bg-[#1D2129]" />
      <div className="noschat-scroll flex max-h-[40vh] w-full flex-col items-center gap-2 overflow-y-auto">
        {guilds.map((g) => (
          <GuildIcon
            key={g.id}
            guild={g}
            active={activeGuildId === g.id}
            compact={compact}
            hasUnread={unreadGuildIds?.has(g.id) ?? false}
            onClick={() => onSelectGuild(g.id)}
          />
        ))}
      </div>
      <button
        onClick={onOpenCreateJoin}
        title="Create or join a server"
        className={`group flex flex-none items-center justify-center rounded-full border border-dashed border-[#2A2F3A] text-[#8B93A1] transition-all duration-200 hover:rounded-xl hover:border-[#F0A868]/50 hover:text-[#F0A868] ${compact ? "h-10 w-10" : "h-12 w-12"}`}
      >
        <Plus className="size-5" />
      </button>
    </>
  );
}
