"use client";

// Main guild UI: channel sidebar (categories + text/voice channels, with
// real-time voice presence badges) + header + either a text channel view
// (message list/composer, same visual language as chat-app.tsx's DM view)
// or a voice channel view (connected members, mic mute, disconnect).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Hash,
  Volume2,
  ChevronDown,
  ChevronRight,
  Settings,
  UserPlus,
  Send,
  Mic,
  MicOff,
  PhoneOff,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { avatarRamp, initialOf } from "@/lib/utils";
import {
  getGuild,
  listGuildMessages,
  sendGuildMessage,
  listGuildMembers,
  hasPermission,
  PERMISSIONS,
  type GuildDetail,
  type GuildChannel,
  type GuildMessage,
  type ChannelCategory,
  type GuildMember,
} from "@/lib/backend-api";
import { useRealtime } from "@/lib/realtime-context";
import { useVoice } from "@/lib/voice-context";
import { Users } from "lucide-react";

function Avatar({
  seed,
  label,
  size = "md",
}: {
  seed: string;
  label: string;
  size?: "sm" | "md" | "lg";
}) {
  const dims =
    size === "sm"
      ? "h-7 w-7 text-xs"
      : size === "lg"
        ? "h-16 w-16 text-2xl"
        : "h-9 w-9 text-sm";
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full bg-gradient-to-br font-semibold text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.3)_inset] ${dims} ${avatarRamp(seed)}`}
    >
      {initialOf(label)}
    </span>
  );
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

type ChannelGroup = {
  category: ChannelCategory | null;
  channels: GuildChannel[];
};

function groupChannels(categories: ChannelCategory[], channels: GuildChannel[]): ChannelGroup[] {
  const sortedCats = [...categories].sort((a, b) => a.position - b.position);
  const groups: ChannelGroup[] = sortedCats.map((c) => ({ category: c, channels: [] }));
  const uncategorized: ChannelGroup = { category: null, channels: [] };
  for (const ch of [...channels].sort((a, b) => a.position - b.position)) {
    if (ch.category_id) {
      const g = groups.find((g) => g.category?.id === ch.category_id);
      if (g) {
        g.channels.push(ch);
        continue;
      }
    }
    uncategorized.channels.push(ch);
  }
  return uncategorized.channels.length > 0 ? [uncategorized, ...groups] : groups;
}

export function GuildView({
  guildId,
  myId,
  onOpenSettings,
  onOpenInvite,
}: {
  guildId: string;
  myId: string | null;
  onOpenSettings: () => void;
  onOpenInvite: () => void;
}) {
  const { getToken } = useAuth();
  const { subscribe } = useRealtime();
  const { voice, joinVoiceChannel, leaveVoiceChannel, toggleMic } = useVoice();

  const [detail, setDetail] = useState<GuildDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, GuildMessage[]>>({});
  const [composer, setComposer] = useState("");
  // user_id -> display name (nickname if set, else username), fetched once
  // per guild so message/voice-presence lists can show real names instead
  // of raw UUIDs.
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<GuildMember[]>([]);
  const [showMemberList, setShowMemberList] = useState(true);
  // channel_id -> user_ids currently in that voice channel (real-time,
  // independent of whether *we* are connected to it).
  const [voicePresence, setVoicePresence] = useState<Record<string, string[]>>({});
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const refreshDetail = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const d = await getGuild(token, guildId);
      setDetail(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load server");
    }
  }, [getToken, guildId]);

  useEffect(() => {
    setDetail(null);
    setActiveChannelId(null);
    setMemberNames({});
    void refreshDetail();
  }, [refreshDetail]);

  // Fetch the member list once per guild so messages/voice presence can
  // resolve raw user ids to a real display name (nickname > username >
  // a short id fallback for members who somehow have neither).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const members = await listGuildMembers(token, guildId);
        if (cancelled) return;
        setMembers(members);
        const map: Record<string, string> = {};
        for (const m of members) {
          map[m.user_id] = m.nickname || m.username || `user-${m.user_id.slice(0, 8)}`;
        }
        setMemberNames(map);
      } catch {
        // Non-fatal — names just fall back to raw ids below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, guildId]);

  function nameFor(userId: string): string {
    if (userId === myId) return "You";
    return memberNames[userId] ?? userId;
  }

  // Default to the first text channel once channels load.
  useEffect(() => {
    if (!detail || activeChannelId) return;
    const firstText = [...detail.channels].sort((a, b) => a.position - b.position).find((c) => c.kind === "text");
    if (firstText) setActiveChannelId(firstText.id);
  }, [detail, activeChannelId]);

  const activeChannel = detail?.channels.find((c) => c.id === activeChannelId) ?? null;

  useEffect(() => {
    if (!activeChannel || activeChannel.kind !== "text") return;
    const channelId = activeChannel.id;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const msgs = await listGuildMessages(token, guildId, channelId);
        setMessagesByChannel((prev) => ({ ...prev, [channelId]: msgs }));
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Failed to load messages");
      }
    })();
  }, [activeChannel, getToken, guildId]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "guild_message" && event.guild_id === guildId) {
        const m = event.message;
        setMessagesByChannel((prev) => {
          const existing = prev[m.channel_id] ?? [];
          if (existing.some((x) => x.id === m.id)) return prev;
          return { ...prev, [m.channel_id]: [...existing, m] };
        });
      } else if (event.type === "voice_channel_state") {
        setVoicePresence((prev) => ({ ...prev, [event.channel_id]: event.user_ids }));
      } else if (event.type === "voice_user_joined") {
        setVoicePresence((prev) => {
          const existing = prev[event.channel_id] ?? [];
          if (existing.includes(event.user_id)) return prev;
          return { ...prev, [event.channel_id]: [...existing, event.user_id] };
        });
      } else if (event.type === "voice_user_left") {
        setVoicePresence((prev) => ({
          ...prev,
          [event.channel_id]: (prev[event.channel_id] ?? []).filter((u) => u !== event.user_id),
        }));
      }
    });
  }, [subscribe, guildId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeChannelId, messagesByChannel]);

  useEffect(() => {
    if (!headerMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [headerMenuOpen]);

  function selectChannel(channel: GuildChannel) {
    if (channel.kind === "voice") {
      void joinVoiceChannel(guildId, channel.id);
    }
    setActiveChannelId(channel.id);
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!activeChannel || activeChannel.kind !== "text" || !composer.trim()) return;
    const token = await getToken();
    if (!token) return;
    const content = composer.trim();
    const channelId = activeChannel.id;
    setComposer("");
    try {
      await sendGuildMessage(token, guildId, channelId, content);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to send message");
      setComposer(content);
    }
  }

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend(e as unknown as FormEvent);
    }
  }

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[#8B93A1]">
        {loadError ?? "Loading server…"}
      </div>
    );
  }

  const myPerms = detail.my_permissions;
  const canManageGuild = hasPermission(myPerms, PERMISSIONS.MANAGE_GUILD);
  const groups = groupChannels(detail.categories, detail.channels);
  const activeMessages = activeChannel ? (messagesByChannel[activeChannel.id] ?? []) : [];
  const inVoiceChannel = voice.channelId === activeChannel?.id;

  // Anyone present in any voice channel right now counts as "in voice" for
  // the member list badge — the only real-time presence signal this app
  // has (there's no general online/offline tracking for guild members).
  const membersInVoice = new Set(Object.values(voicePresence).flat());

  // Group members by their highest-position role (Discord-style member
  // list sections), falling back to "Members" for anyone with only the
  // default @everyone role.
  const roleGroups: { roleName: string; roleColor: string | null; members: GuildMember[] }[] = (() => {
    const byRole = new Map<string, { roleName: string; roleColor: string | null; members: GuildMember[] }>();
    const noRole: GuildMember[] = [];
    for (const m of members) {
      const nonDefaultRoles = m.roles.filter((r) => r.name !== "@everyone");
      if (nonDefaultRoles.length === 0) {
        noRole.push(m);
        continue;
      }
      const top = nonDefaultRoles[0];
      const key = top.id;
      if (!byRole.has(key)) {
        byRole.set(key, { roleName: top.name, roleColor: top.color, members: [] });
      }
      byRole.get(key)!.members.push(m);
    }
    const groups = [...byRole.values()];
    if (noRole.length > 0) groups.push({ roleName: "Members", roleColor: null, members: noRole });
    return groups;
  })();

  return (
    <div className="flex min-w-0 flex-1">
      {/* Channel sidebar */}
      <div className="noschat-grain flex w-60 flex-none flex-col border-r border-[#1D2129] bg-[#12151B]">
        <div ref={headerMenuRef} className="relative flex h-16 flex-none items-center justify-between border-b border-[#1D2129] px-4">
          <button
            onClick={() => setHeaderMenuOpen((v) => !v)}
            className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-[#E8EAED] hover:text-[#F0A868]"
          >
            {detail.name}
          </button>
          {headerMenuOpen && (
            <div className="animate-rise-in absolute top-14 right-2 left-2 z-50 overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] py-1.5 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.7)]">
              <button
                onClick={() => {
                  setHeaderMenuOpen(false);
                  onOpenInvite();
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#E8EAED] transition-colors hover:bg-[#1B1F27]"
              >
                <UserPlus className="size-4 text-[#8B93A1]" /> Invite People
              </button>
              {canManageGuild && (
                <button
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    onOpenSettings();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#E8EAED] transition-colors hover:bg-[#1B1F27]"
                >
                  <Settings className="size-4 text-[#8B93A1]" /> Server Settings
                </button>
              )}
            </div>
          )}
        </div>

        <div className="noschat-scroll flex-1 overflow-y-auto px-2 py-3">
          {groups.map((group) => {
            const catId = group.category?.id ?? "__uncategorized";
            const collapsed = collapsedCategories[catId];
            return (
              <div key={catId} className="mb-2">
                {group.category && (
                  <button
                    onClick={() =>
                      setCollapsedCategories((prev) => ({ ...prev, [catId]: !prev[catId] }))
                    }
                    className="flex w-full items-center gap-1 px-1.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1] hover:text-[#E8EAED]"
                  >
                    {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                    {group.category.name}
                  </button>
                )}
                {!collapsed && (
                  <div className="space-y-0.5">
                    {group.channels.map((ch) => {
                      const isActive = activeChannelId === ch.id;
                      const presentUsers = voicePresence[ch.id] ?? [];
                      return (
                        <div key={ch.id}>
                          <button
                            onClick={() => selectChannel(ch)}
                            data-active={isActive}
                            className="group flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1E232C] data-[active=true]:text-[#E8EAED]"
                          >
                            {ch.kind === "text" ? (
                              <Hash className="size-4 flex-none text-[#8B93A1]/70" />
                            ) : (
                              <Volume2 className="size-4 flex-none text-[#8B93A1]/70" />
                            )}
                            <span className="truncate">{ch.name}</span>
                          </button>
                          {ch.kind === "voice" && presentUsers.length > 0 && (
                            <div className="ml-6 flex flex-col gap-1 py-1">
                              {presentUsers.map((uid) => (
                                <div key={uid} className="flex items-center gap-1.5 text-xs text-[#8B93A1]">
                                  <Avatar seed={uid} label={nameFor(uid)} size="sm" />
                                  <span className="truncate">{nameFor(uid)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {voice.channelId && (
          <div className="flex flex-none items-center gap-2 border-t border-[#1D2129] bg-[#0B0D12]/60 px-2.5 py-2.5">
            <span className="min-w-0 flex-1 truncate text-xs text-[#4ADE80]">
              Voice Connected
            </span>
            <Button size="icon-sm" variant="ghost" onClick={toggleMic} title={voice.micMuted ? "Unmute" : "Mute"}>
              {voice.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={leaveVoiceChannel} title="Disconnect">
              <PhoneOff className="size-4 text-[#EB5757]" />
            </Button>
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-[#161A20]">
        {loadError && (
          <div className="flex flex-none items-center justify-between gap-2 border-b border-[#EB5757]/20 bg-[#EB5757]/10 px-4 py-2 text-xs text-[#EB5757]">
            <span>{loadError}</span>
          </div>
        )}

        {!activeChannel ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[#8B93A1]">
            Select a channel
          </div>
        ) : activeChannel.kind === "text" ? (
          <>
            <div className="flex h-16 flex-none items-center gap-2 border-b border-[#1D2129] px-4">
              <Hash className="size-5 text-[#8B93A1]" />
              <span className="text-sm font-semibold text-[#E8EAED]">{activeChannel.name}</span>
              {activeChannel.topic && (
                <>
                  <span className="mx-1 h-4 w-px bg-[#2A2F3A]" />
                  <span className="truncate text-xs text-[#8B93A1]">{activeChannel.topic}</span>
                </>
              )}
              <div className="flex-1" />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setShowMemberList((v) => !v)}
                title={showMemberList ? "Hide member list" : "Show member list"}
                className={showMemberList ? "text-[#F0A868]" : "text-[#8B93A1]"}
              >
                <Users className="size-4" />
              </Button>
            </div>

            <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="noschat-scroll flex-1 overflow-y-auto px-4 py-5 md:px-6">
              {activeMessages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <Hash className="size-10 text-[#8B93A1]/40" />
                  <h2 className="font-display text-2xl italic text-[#E8EAED]">
                    Welcome to #{activeChannel.name}
                  </h2>
                  <p className="max-w-sm text-sm text-[#8B93A1]">
                    This is the start of the channel.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {activeMessages.map((m) => (
                    <div key={m.id} className="animate-rise-in flex gap-2.5">
                      <Avatar seed={m.sender_id} label={nameFor(m.sender_id)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-semibold text-[#E8EAED]">
                            {nameFor(m.sender_id)}
                          </span>
                          <span className="font-mono text-[10px] text-[#8B93A1]">
                            {clockTime(m.created_at)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed break-words text-[#C7CDD6]">
                          {m.content}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form onSubmit={handleSend} className="flex-none px-3 pb-4 md:px-6 md:pb-5">
              <div className="relative flex items-end gap-1.5">
                <Textarea
                  ref={composerRef}
                  rows={1}
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={`Message #${activeChannel.name}`}
                  className="max-h-[168px] min-h-12 rounded-3xl border-[#2A2F3A] bg-[#0F1217]/80 py-3 pr-12 pl-4 text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus-visible:border-[#F0A868]/50 focus-visible:ring-[#F0A868]/20"
                />
                <Button
                  type="submit"
                  size="icon"
                  variant="ghost"
                  disabled={!composer.trim()}
                  title="Send message"
                  className={`absolute right-1.5 bottom-1.5 rounded-full transition-all duration-200 ${
                    composer.trim()
                      ? "bg-[#F0A868]/15 text-[#F0A868] hover:bg-[#F0A868]/25"
                      : "text-[#8B93A1] opacity-30"
                  }`}
                >
                  <Send className="size-4" />
                </Button>
              </div>
            </form>
            </div>

            {showMemberList && (
              <div className="noschat-scroll flex w-56 flex-none flex-col gap-4 overflow-y-auto border-l border-[#1D2129] bg-[#12151B] px-3 py-4">
                {roleGroups.length === 0 && members.length === 0 ? (
                  <p className="px-1 text-xs text-[#8B93A1]">Loading members…</p>
                ) : (
                  roleGroups.map((g) => (
                    <div key={g.roleName}>
                      <p
                        className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-[0.15em]"
                        style={{ color: g.roleColor ?? "#8B93A1" }}
                      >
                        {g.roleName} — {g.members.length}
                      </p>
                      <div className="space-y-0.5">
                        {g.members.map((m) => {
                          const label = m.nickname || m.username || `user-${m.user_id.slice(0, 8)}`;
                          const inVoice = membersInVoice.has(m.user_id);
                          return (
                            <div
                              key={m.user_id}
                              className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[#1B1F27]"
                            >
                              <Avatar seed={m.user_id} label={label} size="sm" />
                              <span className="min-w-0 flex-1 truncate text-sm text-[#C7CDD6]">
                                {m.user_id === myId ? "You" : label}
                              </span>
                              {inVoice && (
                                <Volume2 className="size-3.5 flex-none text-[#4ADE80]" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            </div>
          </>
        ) : (
          <>
            <div className="flex h-16 flex-none items-center gap-2 border-b border-[#1D2129] px-4">
              <Volume2 className="size-5 text-[#8B93A1]" />
              <span className="text-sm font-semibold text-[#E8EAED]">{activeChannel.name}</span>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
              {!inVoiceChannel ? (
                <>
                  <Volume2 className="size-12 text-[#8B93A1]/40" />
                  <p className="text-sm text-[#8B93A1]">Not connected to this voice channel</p>
                  <Button onClick={() => void joinVoiceChannel(guildId, activeChannel.id)}>
                    Join Voice
                  </Button>
                </>
              ) : (
                <>
                  <div className="grid w-full max-w-2xl grid-cols-2 gap-4 sm:grid-cols-3">
                    <div className="flex flex-col items-center gap-2 rounded-xl border border-[#2A2F3A] bg-[#12151B] p-4">
                      <Avatar seed={myId ?? "me"} label="You" size="lg" />
                      <span className="text-sm text-[#E8EAED]">
                        You {voice.micMuted && "(muted)"}
                      </span>
                    </div>
                    {Object.entries(voice.peers).map(([userId, peer]) => (
                      <div
                        key={userId}
                        className="flex flex-col items-center gap-2 rounded-xl border border-[#2A2F3A] bg-[#12151B] p-4"
                      >
                        <Avatar seed={userId} label={nameFor(userId)} size="lg" />
                        <span className="truncate text-sm text-[#E8EAED]">{nameFor(userId)}</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-[#8B93A1]">
                          {peer.connectionState}
                        </span>
                        {peer.stream && (
                          // eslint-disable-next-line jsx-a11y/media-has-caption -- remote voice audio, no captions applicable
                          <audio
                            autoPlay
                            ref={(el) => {
                              if (el && el.srcObject !== peer.stream) el.srcObject = peer.stream;
                            }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <Button variant="secondary" onClick={toggleMic}>
                      {voice.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                      {voice.micMuted ? "Unmute" : "Mute"}
                    </Button>
                    <Button variant="destructive" onClick={leaveVoiceChannel}>
                      <LogOut className="size-4" /> Disconnect
                    </Button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
