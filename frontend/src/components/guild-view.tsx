"use client";

// Main guild UI: channel sidebar (categories + text/voice channels, with
// real-time voice presence badges) + header + either a text channel view
// (message list/composer, same visual language as chat-app.tsx's DM view)
// or a voice channel view (connected members, mic mute, disconnect).

import {
  useCallback,
  useEffect,
  useMemo,
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
  Settings,
  UserPlus,
  Send,
  Mic,
  MicOff,
  PhoneOff,
  LogOut,
  Plus,
  FolderPlus,
  Trash2,
  X,
  Pencil,
  Reply,
  ArrowUp,
  ArrowDown,
  Paperclip,
  Smile,
  Headphones,
  ScreenShare,
  Video,
  VideoOff,
  Maximize2,
  Copy,
  Pin,
  PinOff,
  Timer,
  Search,
} from "lucide-react";
import { useContextMenuHandler } from "@/lib/context-menu";
import { Button } from "@/components/ui/button";
import { AttachmentPreview } from "@/components/attachment-preview";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { EmojiPicker } from "@/components/emoji-picker";
import { avatarRamp, initialOf } from "@/lib/utils";
import {
  getGuild,
  listGuildMessages,
  sendGuildMessage,
  fetchGuildAttachmentUrl,
  listGuildMembers,
  hasPermission,
  PERMISSIONS,
  createGuildChannel,
  createGuildCategory,
  deleteGuildChannel,
  listGuildEmoji,
  guildEmojiUrl,
  type GuildEmoji,
  updateGuildChannel,
  leaveGuild,
  deleteGuild,
  markGuildChannelRead,
  getGuildUnread,
  editGuildMessage,
  deleteGuildMessage,
  toggleGuildReaction,
  kickGuildMember,
  banGuildMember,
  pinGuildMessage,
  unpinGuildMessage,
  listPinnedMessages,
  searchGuildMessages,
  type GuildDetail,
  type GuildChannel,
  type GuildMessage,
  type ChannelCategory,
  type ChannelKind,
  type GuildMember,
} from "@/lib/backend-api";
import { useRealtime } from "@/lib/realtime-context";
import { useVoice } from "@/lib/voice-context";
import { Users } from "lucide-react";
import { ConfirmModal } from "@/components/confirm-modal";
import { ReactionBar } from "@/components/reaction-bar";
import { usePresence } from "@/lib/presence-context";
import { useSettings } from "@/lib/settings-context";
import { ClickableAvatar } from "@/components/profile-card";

function Avatar({
  seed,
  label,
  size = "md",
}: {
  seed: string;
  label: string;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const dims =
    size === "sm"
      ? "h-7 w-7 text-xs"
      : size === "lg"
        ? "h-16 w-16 text-2xl"
        : size === "xl"
          ? "h-20 w-20 text-3xl"
          : "h-9 w-9 text-sm";
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full bg-gradient-to-br font-semibold text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.3)_inset] ${dims} ${avatarRamp(seed)}`}
    >
      {initialOf(label)}
    </span>
  );
}

// Lightweight, UI-layer-only speaking detector: attaches a Web Audio
// AnalyserNode to a MediaStream's audio track and polls its volume via
// requestAnimationFrame, exposing a simple boolean once it crosses a
// threshold. This is purely presentational (drives the green speaking
// ring) and never touches voice-context.tsx's signaling/track logic —
// it just reads from the same MediaStream objects that are already
// exposed on voice state.
function useIsSpeaking(stream: MediaStream | null | undefined, muted = false): boolean {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!stream || muted || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    let raf = 0;
    let cancelled = false;
    const AudioContextCtor =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (cancelled) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      setSpeaking(avg > 12);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
    };
  }, [stream, muted]);

  return speaking;
}

// One participant's tile in the voice-channel grid: video feed when the
// camera is on, otherwise a large avatar — with a speaking ring/pulse
// (green, matching the app's existing "in voice"/online accents) and a
// bottom-left name + mute badge, matching Discord's call grid layout.
function VoiceTile({
  seed,
  label,
  stream,
  isLocal = false,
  micMuted = false,
  deafened = false,
  spotlight = false,
  screenSharing = false,
}: {
  seed: string;
  label: string;
  stream: MediaStream | null | undefined;
  isLocal?: boolean;
  micMuted?: boolean;
  deafened?: boolean;
  spotlight?: boolean;
  screenSharing?: boolean;
}) {
  const speaking = useIsSpeaking(stream, micMuted || (deafened && !isLocal));
  const hasVideo = !!stream?.getVideoTracks().length;

  return (
    <div
      data-speaking={speaking}
      className={`group relative flex ${spotlight ? "h-full w-full" : "aspect-video min-h-[140px]"} flex-col items-center justify-center overflow-hidden rounded-xl border border-[#2A2F3A] bg-[#12151B] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ring-2 ring-transparent transition-all duration-150 data-[speaking=true]:border-[#4ADE80]/60 data-[speaking=true]:ring-[#4ADE80]/70 data-[speaking=true]:shadow-[0_0_0_3px_rgba(74,222,128,0.15)]`}
    >
      {hasVideo && stream ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- voice call video, no captions applicable
        <video
          autoPlay
          playsInline
          muted={isLocal}
          className="absolute inset-0 h-full w-full object-cover"
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
        />
      ) : (
        <div className="flex flex-col items-center gap-2">
          <span
            data-speaking={speaking}
            className="rounded-full p-1 ring-2 ring-transparent transition-all duration-150 data-[speaking=true]:animate-speaking-pulse data-[speaking=true]:ring-[#4ADE80]"
          >
            {isLocal ? (
              <Avatar seed={seed} label={label} size="xl" />
            ) : (
              <ClickableAvatar userId={seed} label={label} size="xl" showStatus={false} />
            )}
          </span>
        </div>
      )}

      {stream && !isLocal && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- remote voice audio, no captions applicable
        <audio
          autoPlay
          muted={deafened}
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
        />
      )}

      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 backdrop-blur-sm">
        {micMuted ? (
          <MicOff className="size-3.5 flex-none text-[#EB5757]" />
        ) : (
          <Mic className="size-3.5 flex-none text-[#8B93A1]" />
        )}
        <span className="max-w-[10rem] truncate text-xs font-medium text-[#E8EAED]">{label}</span>
        {screenSharing && (
          <span className="flex items-center gap-1 rounded-full bg-[#4ADE80]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#4ADE80]">
            <ScreenShare className="size-2.5" /> Live
          </span>
        )}
      </div>
    </div>
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

function groupChannels(
  categories: ChannelCategory[],
  channels: GuildChannel[],
  allowNsfw: boolean,
): ChannelGroup[] {
  const sortedCats = [...categories].sort((a, b) => a.position - b.position);
  const groups: ChannelGroup[] = sortedCats.map((c) => ({ category: c, channels: [] }));
  const uncategorized: ChannelGroup = { category: null, channels: [] };
  for (const ch of [...channels].sort((a, b) => a.position - b.position)) {
    if (ch.is_nsfw && !allowNsfw) continue;
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
  onLeftGuild,
  onUnreadChanged,
}: {
  guildId: string;
  myId: string | null;
  onOpenSettings: () => void;
  onOpenInvite: () => void;
  onLeftGuild?: () => void;
  // Notifies the parent (chat-app.tsx) whenever this guild's total unread
  // count changes, so the guild-rail ping dot stays accurate even though
  // the rail lives outside this component's subtree.
  onUnreadChanged?: (guildId: string, totalUnread: number) => void;
}) {
  const { getToken } = useAuth();
  const { subscribe, sendGuildTyping } = useRealtime();
  const { voice, joinVoiceChannel, leaveVoiceChannel, toggleMic, toggleDeafen, toggleCamera, toggleScreenShare } = useVoice();
  const { fetchProfile } = usePresence();
  const { settings } = useSettings();
  const handleContextMenu = useContextMenuHandler();

  const [detail, setDetail] = useState<GuildDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  // Deafen mutes ALL incoming peer audio at the track level (implemented in
  // voice-context.tsx's toggleDeafen) plus force-mutes the mic while active,
  // matching Discord semantics — this used to be a local-only stub that did
  // nothing to actual audio, now it's real.
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, GuildMessage[]>>({});
  const [typingByChannel, setTypingByChannel] = useState<Record<string, Set<string>>>({});
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [composer, setComposer] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const attachFileInputRef = useRef<HTMLInputElement>(null);
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
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const [guildEmoji, setGuildEmoji] = useState<GuildEmoji[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const list = await listGuildEmoji(token, guildId);
        if (!cancelled) setGuildEmoji(list);
      } catch {
        // Non-fatal — the picker just shows no "Server" tab.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, guildId]);

  useEffect(() => {
    if (!emojiPickerOpen) return;
    function onClick(e: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setEmojiPickerOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [emojiPickerOpen]);

  function insertEmoji(char: string) {
    setComposer((prev) => `${prev}${char} `);
    composerRef.current?.focus();
  }

  // Resolves `:emoji_name:` shortcodes in message text to inline custom
  // emoji images (falls back to literal text if the name isn't a known
  // emoji in this guild — same as Discord leaving unknown shortcodes as
  // plain text).
  const emojiByName = useMemo(() => {
    const map = new Map<string, GuildEmoji>();
    for (const em of guildEmoji) map.set(em.name, em);
    return map;
  }, [guildEmoji]);

  function renderMessageContent(content: string) {
    if (emojiByName.size === 0 || !content.includes(":")) return content;
    const parts = content.split(/(:[a-zA-Z0-9_]{2,32}:)/g);
    if (parts.length === 1) return content;
    return parts.map((part, i) => {
      const match = /^:([a-zA-Z0-9_]{2,32}):$/.exec(part);
      const em = match ? emojiByName.get(match[1]) : undefined;
      if (em) {
        return (
          <img
            key={i}
            src={guildEmojiUrl(guildId, em.id)}
            alt={part}
            title={part}
            className="inline-block size-5 -translate-y-0.5 align-middle object-contain"
          />
        );
      }
      return <span key={i}>{part}</span>;
    });
  }

  // Create-channel / create-category modal state. `addChannelCategoryId` is
  // undefined when the modal is closed, null for "no category" (top-level),
  // or a category id when launched from a specific category's "+" button.
  const [addChannelCategoryId, setAddChannelCategoryId] = useState<string | null | undefined>(
    undefined,
  );
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelKind, setNewChannelKind] = useState<ChannelKind>("text");
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [channelActionError, setChannelActionError] = useState<string | null>(null);

  const [addCategoryOpen, setAddCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);

  const [pendingDeleteChannel, setPendingDeleteChannel] = useState<GuildChannel | null>(null);
  const [editingChannel, setEditingChannel] = useState<GuildChannel | null>(null);
  const [channelSettingsSaving, setChannelSettingsSaving] = useState(false);
  const [deletingChannel, setDeletingChannel] = useState(false);

  const [leaveOrDeleteOpen, setLeaveOrDeleteOpen] = useState(false);
  const [leavingOrDeleting, setLeavingOrDeleting] = useState(false);
  const [leaveOrDeleteError, setLeaveOrDeleteError] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GuildMessage[]>([]);
  const [searching, setSearching] = useState(false);


  // Inline edit state for guild text messages — same pattern as chat-app.tsx's
  // DM message editing.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<{ channelId: string; id: string } | null>(null);
  const [deletingMessage, setDeletingMessage] = useState(false);
  // Reply-to state — set when the user picks "Reply" on a message; shown
  // as a dismissible quote strip above the composer, cleared on send.
  const [replyTarget, setReplyTarget] = useState<GuildMessage | null>(null);

  // channel_id -> unread count, from GET /guilds/:id/unread. Only entries
  // with unread_count > 0 are returned by the backend, so any channel not
  // present here is implicitly read.
  const [unreadByChannel, setUnreadByChannel] = useState<Record<string, number>>({});

  const refreshUnread = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const entries = await getGuildUnread(token, guildId);
      const map: Record<string, number> = {};
      for (const e of entries) map[e.channel_id] = e.unread_count;
      setUnreadByChannel(map);
    } catch {
      // Non-fatal — unread badges just won't show this round.
    }
  }, [getToken, guildId]);

  useEffect(() => {
    void refreshUnread();
  }, [refreshUnread]);

  // Report the total across all channels to the parent whenever it changes,
  // so the guild-rail ping dot (rendered outside this subtree) stays live.
  useEffect(() => {
    const total = Object.values(unreadByChannel).reduce((a, b) => a + b, 0);
    onUnreadChanged?.(guildId, total);
  }, [unreadByChannel, guildId, onUnreadChanged]);

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
        // Best-effort presence snapshot: guild members aren't necessarily
        // friends (the only cohort presence_update broadcasts reach), so
        // fetch each member's real public profile once to seed the status
        // dot with an accurate initial value. Live updates after this
        // still only arrive for actual friends — a known limitation, not
        // fabricated data.
        for (const m of members) {
          void fetchProfile(m.user_id);
        }
      } catch {
        // Non-fatal — names just fall back to raw ids below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, guildId, fetchProfile]);

  function nameFor(userId: string): string {
    if (userId === myId) return "You";
    return memberNames[userId] ?? userId;
  }

  // Discord-style role color: the member's highest-position role that has
  // a non-default color wins (roles come back from list_members already
  // ordered by position DESC, so [0] is highest). Falls back to the
  // default text color if the member has no colored role.
  function roleColorFor(userId: string): string | null {
    const m = members.find((mm) => mm.user_id === userId);
    const colored = m?.roles.find((r) => r.color && r.color.toLowerCase() !== "#99aab5" && r.color.toLowerCase() !== "#e8eaed");
    return colored?.color ?? null;
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
        // Opening a text channel marks it read, mirroring the DM markDmRead
        // trigger in chat-app.tsx.
        await markGuildChannelRead(token, guildId, channelId).catch(() => {});
        setUnreadByChannel((prev) => {
          if (!(channelId in prev)) return prev;
          const next = { ...prev };
          delete next[channelId];
          return next;
        });
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
        // A new message landed in some channel of this guild. If it's the
        // channel currently open, it's implicitly read (no badge); for any
        // other channel, refetch the real unread counts from the backend
        // rather than guessing/incrementing client-side.
        if (m.channel_id !== activeChannelId) {
          void refreshUnread();
        }
      } else if (event.type === "guild_message_edited" && event.guild_id === guildId) {
        const m = event.message;
        setMessagesByChannel((prev) => {
          const existing = prev[m.channel_id];
          if (!existing) return prev;
          return { ...prev, [m.channel_id]: existing.map((x) => (x.id === m.id ? m : x)) };
        });
      } else if (event.type === "guild_message_deleted" && event.guild_id === guildId) {
        setMessagesByChannel((prev) => {
          const existing = prev[event.channel_id];
          if (!existing) return prev;
          return {
            ...prev,
            [event.channel_id]: existing.filter((x) => x.id !== event.message_id),
          };
        });
      } else if (event.type === "guild_reaction_update" && event.guild_id === guildId) {
        setMessagesByChannel((prev) => {
          const existing = prev[event.channel_id];
          if (!existing) return prev;
          return {
            ...prev,
            [event.channel_id]: existing.map((x) =>
              x.id === event.message_id ? { ...x, reactions: event.reactions } : x,
            ),
          };
        });
      } else if (event.type === "guild_typing" && event.guild_id === guildId) {
        const channelId = event.channel_id;
        const userId = event.user_id;
        setTypingByChannel((prev) => {
          const existing = prev[channelId] ?? new Set<string>();
          const next = new Set(existing);
          next.add(userId);
          return { ...prev, [channelId]: next };
        });
        // Typing presence has no explicit "stopped" event (matches the DM
        // typing indicator's own design) — just expire it locally after a
        // few seconds of silence.
        const key = `${channelId}:${userId}`;
        if (typingTimeouts.current[key]) clearTimeout(typingTimeouts.current[key]);
        typingTimeouts.current[key] = setTimeout(() => {
          setTypingByChannel((prev) => {
            const existing = prev[channelId];
            if (!existing || !existing.has(userId)) return prev;
            const next = new Set(existing);
            next.delete(userId);
            return { ...prev, [channelId]: next };
          });
        }, 4000);
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
  }, [subscribe, guildId, activeChannelId, refreshUnread]);

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

  function openAddChannel(categoryId: string | null) {
    setAddChannelCategoryId(categoryId);
    setNewChannelName("");
    setNewChannelKind("text");
    setChannelActionError(null);
  }

  async function handleCreateChannel(e: FormEvent) {
    e.preventDefault();
    if (addChannelCategoryId === undefined || !newChannelName.trim()) return;
    setCreatingChannel(true);
    setChannelActionError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const body: { name: string; kind: ChannelKind; category_id?: string } = {
        name: newChannelName.trim(),
        kind: newChannelKind,
      };
      if (addChannelCategoryId) body.category_id = addChannelCategoryId;
      await createGuildChannel(token, guildId, body);
      setAddChannelCategoryId(undefined);
      await refreshDetail();
    } catch (err) {
      setChannelActionError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setCreatingChannel(false);
    }
  }

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setCreatingCategory(true);
    setChannelActionError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await createGuildCategory(token, guildId, newCategoryName.trim());
      setAddCategoryOpen(false);
      setNewCategoryName("");
      await refreshDetail();
    } catch (err) {
      setChannelActionError(err instanceof Error ? err.message : "Failed to create category");
    } finally {
      setCreatingCategory(false);
    }
  }

  async function handleDeleteChannel() {
    if (!pendingDeleteChannel) return;
    setDeletingChannel(true);
    try {
      const token = await getToken();
      if (!token) return;
      await deleteGuildChannel(token, guildId, pendingDeleteChannel.id);
      if (activeChannelId === pendingDeleteChannel.id) setActiveChannelId(null);
      setPendingDeleteChannel(null);
      await refreshDetail();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to delete channel");
    } finally {
      setDeletingChannel(false);
    }
  }

  async function handleKickMember(userId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await kickGuildMember(token, guildId, userId);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to kick member");
    }
  }

  async function handleBanMember(userId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await banGuildMember(token, guildId, userId);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to ban member");
    }
  }

  // Pinned messages: kept in a per-channel map (like messagesByChannel) so
  // switching channels doesn't lose what's already been fetched. Toggling
  // a pin locally patches messagesByChannel's copy of the message too, so
  // the inline pin icon updates immediately without a full refetch.
  const [pinnedByChannel, setPinnedByChannel] = useState<Record<string, GuildMessage[]>>({});
  const [pinnedPanelOpen, setPinnedPanelOpen] = useState(false);

  async function refreshPinned(channelId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      const pins = await listPinnedMessages(token, guildId, channelId);
      setPinnedByChannel((prev) => ({ ...prev, [channelId]: pins }));
    } catch {
      // best-effort — pinned panel just stays empty/stale on failure
    }
  }

  function patchMessagePinState(channelId: string, messageId: string, pinnedAt: string | null) {
    setMessagesByChannel((prev) => ({
      ...prev,
      [channelId]: (prev[channelId] ?? []).map((m) =>
        m.id === messageId ? { ...m, pinned_at: pinnedAt } : m,
      ),
    }));
  }

  async function handlePinMessage(channelId: string, messageId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      const updated = await pinGuildMessage(token, guildId, channelId, messageId);
      patchMessagePinState(channelId, messageId, updated.pinned_at ?? new Date().toISOString());
      await refreshPinned(channelId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to pin message");
    }
  }

  async function handleUnpinMessage(channelId: string, messageId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await unpinGuildMessage(token, guildId, channelId, messageId);
      patchMessagePinState(channelId, messageId, null);
      await refreshPinned(channelId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to unpin message");
    }
  }

  // Swaps this channel's position with its immediate up/down neighbor
  // *within the same category group* (same list groupChannels() already
  // sorts by position) — two PATCH calls, not a full drag-and-drop reorder,
  // but enough to actually let you reorganize a channel list at all.
  async function handleMoveChannel(channel: GuildChannel, direction: "up" | "down") {
    if (!detail) return;
    const groups = groupChannels(detail.categories, detail.channels, true);
    const group = groups.find((g) => g.channels.some((c) => c.id === channel.id));
    if (!group) return;
    const idx = group.channels.findIndex((c) => c.id === channel.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= group.channels.length) return;
    const other = group.channels[swapIdx];
    try {
      const token = await getToken();
      if (!token) return;
      await Promise.all([
        updateGuildChannel(token, guildId, channel.id, { position: other.position }),
        updateGuildChannel(token, guildId, other.id, { position: channel.position }),
      ]);
      await refreshDetail();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to reorder channel");
    }
  }

  const isOwner = detail?.owner_id === myId;

  async function handleLeaveOrDeleteGuild() {
    setLeavingOrDeleting(true);
    setLeaveOrDeleteError(null);
    try {
      const token = await getToken();
      if (!token) return;
      if (isOwner) {
        await deleteGuild(token, guildId);
      } else {
        await leaveGuild(token, guildId);
      }
      setLeaveOrDeleteOpen(false);
      onLeftGuild?.();
    } catch (err) {
      setLeaveOrDeleteError(
        err instanceof Error ? err.message : `Failed to ${isOwner ? "delete" : "leave"} server`,
      );
    } finally {
      setLeavingOrDeleting(false);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const token = await getToken();
      if (!token) return;
      setSearchResults(await searchGuildMessages(token, guildId, searchQuery.trim()));
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!activeChannel || activeChannel.kind !== "text" || (!composer.trim() && !pendingFile)) return;
    const token = await getToken();
    if (!token) return;
    const content = composer.trim();
    const file = pendingFile;
    const channelId = activeChannel.id;
    const replyToId = replyTarget?.id;
    setComposer("");
    setPendingFile(null);
    setReplyTarget(null);
    try {
      await sendGuildMessage(token, guildId, channelId, content, file ?? undefined, replyToId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to send message");
      setComposer(content);
      setPendingFile(file);
    }
  }

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend(e as unknown as FormEvent);
    }
  }

  function startEditMessage(m: GuildMessage) {
    setEditingMessageId(m.id);
    setEditDraft(m.content);
  }

  function cancelEditMessage() {
    setEditingMessageId(null);
    setEditDraft("");
  }

  async function saveEditMessage(channelId: string, messageId: string) {
    const content = editDraft.trim();
    if (!content) return;
    setEditSaving(true);
    try {
      const token = await getToken();
      if (!token) return;
      const updated = await editGuildMessage(token, guildId, channelId, messageId, content);
      setMessagesByChannel((prev) => ({
        ...prev,
        [channelId]: (prev[channelId] ?? []).map((x) => (x.id === messageId ? updated : x)),
      }));
      setEditingMessageId(null);
      setEditDraft("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to edit message");
    } finally {
      setEditSaving(false);
    }
  }

  async function confirmDeleteMessage() {
    if (!pendingDeleteMessage) return;
    const { channelId, id } = pendingDeleteMessage;
    setDeletingMessage(true);
    try {
      const token = await getToken();
      if (!token) return;
      await deleteGuildMessage(token, guildId, channelId, id);
      setMessagesByChannel((prev) => ({
        ...prev,
        [channelId]: (prev[channelId] ?? []).filter((x) => x.id !== id),
      }));
      setPendingDeleteMessage(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to delete message");
    } finally {
      setDeletingMessage(false);
    }
  }

  async function handleToggleReaction(channelId: string, messageId: string, emoji: string) {
    try {
      const token = await getToken();
      if (!token) return;
      const reactions = await toggleGuildReaction(token, guildId, channelId, messageId, emoji);
      setMessagesByChannel((prev) => ({
        ...prev,
        [channelId]: (prev[channelId] ?? []).map((x) => (x.id === messageId ? { ...x, reactions } : x)),
      }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to react");
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
  const canManageMessages = hasPermission(myPerms, PERMISSIONS.MANAGE_MESSAGES);
  const canKickMembers = hasPermission(myPerms, PERMISSIONS.KICK_MEMBERS);
  const canBanMembers = hasPermission(myPerms, PERMISSIONS.BAN_MEMBERS);
  const groups = groupChannels(detail.categories, detail.channels, canManageGuild || settings.allowNsfwChannels);
  const activeMessages = activeChannel ? (messagesByChannel[activeChannel.id] ?? []) : [];
  const inVoiceChannel = voice.channelId === activeChannel?.id;
  const [vcElapsedSec, setVcElapsedSec] = useState(0);
  useEffect(() => {
    if (!inVoiceChannel) {
      setVcElapsedSec(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setVcElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [inVoiceChannel]);
  function formatVcDuration(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
      : `${m}:${s.toString().padStart(2, "0")}`;
  }

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
              <button
                onClick={() => {
                  setHeaderMenuOpen(false);
                  setLeaveOrDeleteError(null);
                  setLeaveOrDeleteOpen(true);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#EB5757] transition-colors hover:bg-[#EB5757]/10"
              >
                <LogOut className="size-4" /> {isOwner ? "Delete Server" : "Leave Server"}
              </button>
            </div>
          )}
        </div>

        <div className="noschat-scroll flex-1 overflow-y-auto px-2 py-3">
          {canManageGuild && (
            <div className="mb-2 flex items-center gap-1 px-1">
              <button
                onClick={() => openAddChannel(null)}
                className="flex flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
              >
                <Plus className="size-3.5" /> Channel
              </button>
              <button
                onClick={() => {
                  setAddCategoryOpen(true);
                  setNewCategoryName("");
                  setChannelActionError(null);
                }}
                title="New category"
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
              >
                <FolderPlus className="size-3.5" />
              </button>
            </div>
          )}
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
                    <ChevronDown
                      className={`size-3 transition-transform duration-200 ${collapsed ? "-rotate-90" : "rotate-0"}`}
                    />
                    <span className="flex-1 text-left">{group.category.name}</span>
                    {canManageGuild && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          openAddChannel(group.category!.id);
                        }}
                        title="New channel in category"
                        className="rounded p-0.5 text-[#8B93A1] hover:text-[#F0A868]"
                      >
                        <Plus className="size-3" />
                      </span>
                    )}
                  </button>
                )}
                {!collapsed && (
                  <div className="animate-list-item-in space-y-0.5">
                    {group.channels.map((ch) => {
                      const isActive = activeChannelId === ch.id;
                      const presentUsers = voicePresence[ch.id] ?? [];
                      const channelUnread = unreadByChannel[ch.id] ?? 0;
                      return (
                        <div
                          key={ch.id}
                          className="group/channel"
                          onContextMenu={handleContextMenu(() => [
                            { kind: "label" as const, label: ch.name },
                            { kind: "item" as const, label: "Open Channel", onSelect: () => selectChannel(ch) },
                            { kind: "item" as const, label: "Copy Channel ID", icon: Hash, onSelect: () => void navigator.clipboard.writeText(ch.id) },
                            ...(canManageGuild
                              ? [
                                  { kind: "separator" as const },
                                  { kind: "item" as const, label: "Channel Settings", icon: Settings, onSelect: () => setEditingChannel(ch) },
                                  { kind: "separator" as const },
                                  { kind: "item" as const, label: "Move Up", icon: ArrowUp, onSelect: () => void handleMoveChannel(ch, "up") },
                                  { kind: "item" as const, label: "Move Down", icon: ArrowDown, onSelect: () => void handleMoveChannel(ch, "down") },
                                  { kind: "separator" as const },
                                  { kind: "item" as const, label: "Delete Channel", icon: Trash2, danger: true, onSelect: () => setPendingDeleteChannel(ch) },
                                ]
                              : []),
                          ])}
                        >
                          <div
                            data-active={isActive}
                            className="group flex w-full items-center gap-1.5 rounded-lg pr-1 pl-2 text-left text-sm text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1E232C] data-[active=true]:text-[#E8EAED]"
                          >
                            <button
                              onClick={() => selectChannel(ch)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5"
                            >
                              {ch.kind === "text" ? (
                                <Hash className="size-4 flex-none text-[#8B93A1]/70" />
                              ) : (
                                <Volume2 className="size-4 flex-none text-[#8B93A1]/70" />
                              )}
                              <span
                                className={`truncate ${channelUnread > 0 && !isActive ? "font-semibold text-[#E8EAED]" : ""}`}
                              >
                                {ch.name}
                              </span>
                              {channelUnread > 0 && !isActive && (
                                <span className="ml-auto flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-[#EB5757] px-1 text-[9px] font-bold text-white">
                                  {channelUnread > 99 ? "99+" : channelUnread}
                                </span>
                              )}
                            </button>
                            {canManageGuild && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleMoveChannel(ch, "up");
                                }}
                                title="Move up"
                                className="flex-none rounded p-1 opacity-0 transition-opacity group-hover/channel:opacity-100 hover:text-[#F0A868]"
                              >
                                <ArrowUp className="size-3.5" />
                              </button>
                            )}
                            {canManageGuild && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleMoveChannel(ch, "down");
                                }}
                                title="Move down"
                                className="flex-none rounded p-1 opacity-0 transition-opacity group-hover/channel:opacity-100 hover:text-[#F0A868]"
                              >
                                <ArrowDown className="size-3.5" />
                              </button>
                            )}
                            {canManageGuild && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingDeleteChannel(ch);
                                }}
                                title="Delete channel"
                                className="flex-none rounded p-1 opacity-0 transition-opacity group-hover/channel:opacity-100 hover:text-[#EB5757]"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            )}
                          </div>
                          {ch.kind === "voice" && presentUsers.length > 0 && (
                            <div className="ml-6 flex flex-col gap-1 py-1">
                              {presentUsers.map((uid) => (
                                <div key={uid} className="flex items-center gap-1.5 text-xs text-[#8B93A1]">
                                  <ClickableAvatar userId={uid} label={nameFor(uid)} size="sm" />
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
          <div className="flex flex-none flex-col gap-2 border-t border-[#1D2129] bg-[#0B0D12]/60 px-2.5 py-2 pb-2.5">
            {/* Compact "connected to voice" pill — always shown while in a
                call, regardless of whether the voice channel view itself is
                focused, matching Discord's persistent call bar at the
                bottom of the channel sidebar. Clicking it jumps back to the
                voice channel view. */}
            <button
              onClick={() => setActiveChannelId(voice.channelId)}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[#1B1F27]"
              title={inVoiceChannel ? "Voice channel open" : "Return to voice channel"}
            >
              <span className="relative flex size-2 flex-none">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4ADE80] opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-[#4ADE80]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-[#4ADE80]">Voice Connected</span>
                <span className="block truncate text-[11px] text-[#8B93A1]">
                  {detail.channels.find((c) => c.id === voice.channelId)?.name ?? "Voice channel"}
                </span>
              </span>
              {!inVoiceChannel && <Maximize2 className="size-3.5 flex-none text-[#8B93A1]" />}
            </button>
            <div className="flex items-center justify-between gap-1">
              <Button size="icon-sm" variant="ghost" onClick={toggleMic} title={voice.micMuted ? "Unmute" : "Mute"}>
                {voice.micMuted ? <MicOff className="size-4 text-[#EB5757]" /> : <Mic className="size-4" />}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={toggleDeafen}
                title={voice.deafened ? "Undeafen" : "Deafen"}
              >
                <Headphones className={`size-4 ${voice.deafened ? "text-[#EB5757]" : ""}`} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void toggleCamera()}
                title={voice.cameraOn ? "Turn Camera Off" : "Turn Camera On"}
              >
                {voice.cameraOn ? <Video className="size-4 text-[#F0A868]" /> : <VideoOff className="size-4" />}
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={leaveVoiceChannel} title="Disconnect">
                <PhoneOff className="size-4 text-[#EB5757]" />
              </Button>
            </div>
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
              {activeChannel.slow_mode_seconds > 0 && (
                <span
                  className="flex flex-none items-center gap-1 rounded-full bg-[#F0A868]/10 px-2 py-0.5 text-[11px] text-[#F0A868]"
                  title={`Slow mode: ${activeChannel.slow_mode_seconds}s between messages`}
                >
                  <Timer className="size-3" /> {activeChannel.slow_mode_seconds}s
                </span>
              )}
              {activeChannel.is_nsfw && (
                <span className="flex-none rounded-full bg-[#EB5757]/10 px-2 py-0.5 text-[10px] font-semibold text-[#EB5757]">
                  NSFW
                </span>
              )}
              <div className="flex-1" />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setSearchOpen(true)}
                title="Search messages"
                className="text-[#8B93A1]"
              >
                <Search className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  setPinnedPanelOpen((v) => !v);
                  if (!pinnedByChannel[activeChannel.id]) void refreshPinned(activeChannel.id);
                }}
                title={pinnedPanelOpen ? "Hide pinned messages" : "Show pinned messages"}
                className={pinnedPanelOpen ? "text-[#F0A868]" : "text-[#8B93A1]"}
              >
                <Pin className="size-4" />
              </Button>
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

            {pinnedPanelOpen && (
              <div className="noschat-scroll flex-none border-b border-[#1D2129] bg-[#0F1217] px-4 py-3" style={{ maxHeight: "40vh", overflowY: "auto" }}>
                <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                  <Pin className="size-3" /> Pinned Messages — {(pinnedByChannel[activeChannel.id] ?? []).length}
                </p>
                {(pinnedByChannel[activeChannel.id] ?? []).length === 0 ? (
                  <p className="text-xs text-[#8B93A1]">No pinned messages in this channel yet.</p>
                ) : (
                  <div className="space-y-2">
                    {(pinnedByChannel[activeChannel.id] ?? []).map((m) => (
                      <div key={m.id} className="flex items-start gap-2 rounded-lg border border-[#1D2129] bg-[#12151B] p-2.5">
                        <ClickableAvatar userId={m.sender_id} label={nameFor(m.sender_id)} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-semibold text-[#E8EAED]">{nameFor(m.sender_id)}</span>
                            <span className="font-mono text-[10px] text-[#8B93A1]">{clockTime(m.created_at)}</span>
                          </div>
                          <p className="mt-0.5 truncate text-sm text-[#C7CDD6]">{m.content}</p>
                        </div>
                        {canManageMessages && (
                          <button
                            type="button"
                            onClick={() => void handleUnpinMessage(activeChannel.id, m.id)}
                            title="Unpin"
                            className="flex-none rounded-md p-1 text-[#8B93A1] hover:bg-[#1B1F27] hover:text-[#EB5757]"
                          >
                            <PinOff className="size-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex min-h-0 flex-1">
            <div key={activeChannel.id} className="animate-view-in flex min-w-0 flex-1 flex-col">
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
                  {activeMessages.map((m) => {
                    if (m.is_system) {
                      return (
                        <div key={m.id} className="flex items-center gap-2 px-1 py-0.5 text-xs italic text-[#6B7280]">
                          <span className="h-px flex-1 max-w-4 bg-[#2A2F3A]" />
                          <span>{m.content}</span>
                          <span className="font-mono text-[10px] not-italic text-[#4A5060]">{clockTime(m.created_at)}</span>
                        </div>
                      );
                    }
                    const mine = m.sender_id === myId;
                    const canDelete = mine || canManageMessages;
                    return (
                      <div
                        key={m.id}
                        className="group/msg animate-rise-in flex gap-2.5"
                        onContextMenu={handleContextMenu(() => [
                          { kind: "label" as const, label: "Message" },
                          { kind: "item" as const, label: "Copy Text", icon: Copy, onSelect: () => void navigator.clipboard.writeText(m.content) },
                          { kind: "item" as const, label: "Copy Message ID", icon: Hash, onSelect: () => void navigator.clipboard.writeText(m.id) },
                          ...(canManageMessages
                            ? [
                                { kind: "separator" as const },
                                m.pinned_at
                                  ? { kind: "item" as const, label: "Unpin Message", icon: PinOff, onSelect: () => void handleUnpinMessage(activeChannel.id, m.id) }
                                  : { kind: "item" as const, label: "Pin Message", icon: Pin, onSelect: () => void handlePinMessage(activeChannel.id, m.id) },
                              ]
                            : []),
                          { kind: "item" as const, label: "Reply", icon: Reply, onSelect: () => setReplyTarget(m) },
                          ...(mine || canDelete
                            ? [
                                { kind: "separator" as const },
                                ...(mine
                                  ? [{ kind: "item" as const, label: "Edit Message", icon: Pencil, onSelect: () => startEditMessage(m) }]
                                  : []),
                                { kind: "item" as const, label: "Delete Message", icon: Trash2, danger: true, onSelect: () => setPendingDeleteMessage({ channelId: activeChannel.id, id: m.id }) },
                              ]
                            : []),
                        ])}
                      >
                        <ClickableAvatar userId={m.sender_id} label={nameFor(m.sender_id)} />
                        <div className="min-w-0 flex-1">
                          {m.reply_to && (
                            <div className="mb-0.5 flex items-center gap-1.5 text-xs text-[#8B93A1]">
                              <Reply className="size-3 -scale-x-100" />
                              <span className="font-medium text-[#B8BFCC]">{nameFor(m.reply_to.sender_id)}</span>
                              <span className="truncate">{m.reply_to.content}</span>
                            </div>
                          )}
                          <div className="flex items-baseline gap-2">
                            <span
                              className="text-sm font-semibold text-[#E8EAED]"
                              style={roleColorFor(m.sender_id) ? { color: roleColorFor(m.sender_id)! } : undefined}
                            >
                              {nameFor(m.sender_id)}
                            </span>
                            <span className="font-mono text-[10px] text-[#8B93A1]">
                              {clockTime(m.created_at)}
                            </span>
                            {m.edited_at && (
                              <span className="text-[10px] italic text-[#8B93A1]">(edited)</span>
                            )}
                            {m.pinned_at && (
                              <span className="flex items-center gap-0.5 text-[10px] text-[#F0A868]">
                                <Pin className="size-2.5" />
                                Pinned
                              </span>
                            )}
                            {(mine || canDelete) && editingMessageId !== m.id && (
                              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
                                {mine && (
                                  <button
                                    type="button"
                                    onClick={() => startEditMessage(m)}
                                    title="Edit message"
                                    className="flex size-5 items-center justify-center rounded-md text-[#8B93A1] hover:bg-[#1B1F27] hover:text-[#E8EAED]"
                                  >
                                    <Pencil className="size-3" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPendingDeleteMessage({ channelId: activeChannel.id, id: m.id })
                                  }
                                  title="Delete message"
                                  className="flex size-5 items-center justify-center rounded-md text-[#8B93A1] hover:bg-[#EB5757]/15 hover:text-[#EB5757]"
                                >
                                  <Trash2 className="size-3" />
                                </button>
                              </div>
                            )}
                          </div>
                          {editingMessageId === m.id ? (
                            <div className="mt-1 w-full max-w-lg rounded-xl border border-[#F0A868]/40 bg-[#12151B] p-2">
                              <textarea
                                autoFocus
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void saveEditMessage(activeChannel.id, m.id);
                                  } else if (e.key === "Escape") {
                                    cancelEditMessage();
                                  }
                                }}
                                rows={2}
                                className="w-full resize-none rounded-lg border border-[#2A2F3A] bg-[#0F1217] px-2.5 py-1.5 text-sm text-[#E8EAED] outline-none focus:border-[#F0A868]/50"
                              />
                              <div className="mt-1.5 flex justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={cancelEditMessage}
                                  className="rounded-md px-2 py-1 text-xs text-[#8B93A1] hover:bg-[#1B1F27] hover:text-[#E8EAED]"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={editSaving || !editDraft.trim()}
                                  onClick={() => void saveEditMessage(activeChannel.id, m.id)}
                                  className="rounded-md bg-[#F0A868]/15 px-2 py-1 text-xs font-medium text-[#F0A868] hover:bg-[#F0A868]/25 disabled:opacity-50"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap text-sm leading-relaxed break-words text-[#C7CDD6]">
                              {renderMessageContent(m.content)}
                            </p>
                          )}
                          {m.attachment && (
                            <AttachmentPreview
                              attachment={m.attachment}
                              blurByDefault={settings.sensitiveContentBlur && !!activeChannel.is_nsfw}
                              load={async () => {
                                const token = await getToken();
                                if (!token) throw new Error("not signed in");
                                return fetchGuildAttachmentUrl(token, guildId, activeChannel.id, m.id);
                              }}
                            />
                          )}
                          <ReactionBar
                            reactions={m.reactions}
                            onToggle={(emoji) => void handleToggleReaction(activeChannel.id, m.id, emoji)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <form onSubmit={handleSend} className="flex-none px-3 pb-4 md:px-6 md:pb-5">
              {replyTarget && (
                <div className="animate-rise-in mb-1.5 flex items-center gap-2 rounded-lg bg-[#1E232C] px-3 py-1.5 text-xs text-[#C7CCD6]">
                  <Reply className="size-3.5 shrink-0 -scale-x-100 text-[#8B93A1]" />
                  <span className="shrink-0 text-[#8B93A1]">Replying to</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-[#E8EAED]">{nameFor(replyTarget.sender_id)}</span>
                  <button
                    type="button"
                    onClick={() => setReplyTarget(null)}
                    className="shrink-0 text-[#8B93A1] transition-colors hover:text-[#E8EAED]"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {pendingFile && (
                <div className="animate-rise-in mb-1.5 flex items-center gap-2 rounded-lg bg-[#1E232C] px-3 py-1.5 text-xs text-[#C7CCD6]">
                  <Paperclip className="size-3.5 shrink-0 text-[#8B93A1]" />
                  <span className="min-w-0 flex-1 truncate">{pendingFile.name}</span>
                  <span className="shrink-0 text-[#8B93A1]">
                    {(pendingFile.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingFile(null)}
                    className="shrink-0 text-[#8B93A1] transition-colors hover:text-[#E8EAED]"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              <div className="relative flex items-end gap-1.5">
                {(() => {
                  const typists = [...(typingByChannel[activeChannel.id] ?? [])].filter((id) => id !== myId);
                  if (typists.length === 0) return null;
                  const names = typists.map((id) => nameFor(id));
                  const text =
                    names.length === 1
                      ? `${names[0]} is typing…`
                      : names.length === 2
                      ? `${names[0]} and ${names[1]} are typing…`
                      : `${names.length} people are typing…`;
                  return (
                    <span className="pointer-events-none absolute -top-5 left-1 truncate text-xs text-[#8B93A1]">
                      {text}
                    </span>
                  );
                })()}
                <input
                  ref={attachFileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setPendingFile(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  title="Attach a file"
                  onClick={() => attachFileInputRef.current?.click()}
                  className="absolute bottom-2.5 left-2.5 z-10 flex size-8 items-center justify-center rounded-full text-[#8B93A1] transition-colors hover:bg-[#1E232C] hover:text-[#E8EAED]"
                >
                  <Paperclip className="size-4" />
                </button>
                <Textarea
                  ref={composerRef}
                  rows={1}
                  value={composer}
                  onChange={(e) => {
                    setComposer(e.target.value);
                    if (e.target.value.trim()) sendGuildTyping(guildId, activeChannel.id);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={`Message #${activeChannel.name}`}
                  className="max-h-[168px] min-h-12 rounded-3xl border-[#2A2F3A] bg-[#0F1217]/80 py-3 pr-20 pl-11 text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus-visible:border-[#F0A868]/50 focus-visible:ring-[#F0A868]/20"
                />
                <div ref={emojiPickerRef} className="absolute right-10 bottom-1.5">
                  <button
                    type="button"
                    onClick={() => setEmojiPickerOpen((v) => !v)}
                    title="Insert emoji"
                    className={`flex size-8 items-center justify-center rounded-full transition-colors hover:bg-[#1B1F27] ${emojiPickerOpen ? "bg-[#1B1F27] text-[#F0A868]" : "text-[#8B93A1] hover:text-[#E8EAED]"}`}
                  >
                    <Smile className="size-4" />
                  </button>
                  {emojiPickerOpen && (
                    <div className="animate-rise-in absolute bottom-11 right-0 z-50">
                      <EmojiPicker
                        onPick={(char) => {
                          insertEmoji(char);
                          setEmojiPickerOpen(false);
                        }}
                        customEmoji={guildEmoji.map((em) => ({ id: em.id, name: em.name, url: guildEmojiUrl(guildId, em.id) }))}
                      />
                    </div>
                  )}
                </div>
                <Button
                  type="submit"
                  size="icon"
                  variant="ghost"
                  disabled={!composer.trim() && !pendingFile}
                  title="Send message"
                  className={`absolute right-1.5 bottom-1.5 rounded-full transition-all duration-200 ${
                    composer.trim() || pendingFile
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
                              onContextMenu={
                                m.user_id === myId
                                  ? undefined
                                  : handleContextMenu(() => [
                                      { kind: "label" as const, label },
                                      { kind: "item" as const, label: "Copy User ID", icon: Hash, onSelect: () => void navigator.clipboard.writeText(m.user_id) },
                                      ...(canKickMembers || canBanMembers
                                        ? [
                                            { kind: "separator" as const },
                                            ...(canKickMembers
                                              ? [{ kind: "item" as const, label: "Kick Member", danger: true, onSelect: () => void handleKickMember(m.user_id) }]
                                              : []),
                                            ...(canBanMembers
                                              ? [{ kind: "item" as const, label: "Ban Member", danger: true, onSelect: () => void handleBanMember(m.user_id) }]
                                              : []),
                                          ]
                                        : []),
                                    ])
                              }
                            >
                              <ClickableAvatar userId={m.user_id} label={label} size="sm" />
                              <span
                                className="min-w-0 flex-1 truncate text-sm text-[#C7CDD6]"
                                style={roleColorFor(m.user_id) ? { color: roleColorFor(m.user_id)! } : undefined}
                              >
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
              {inVoiceChannel && (
                <span className="ml-2 flex items-center gap-1 rounded-full bg-[#4ADE80]/10 px-2 py-0.5 text-[11px] font-medium text-[#4ADE80]">
                  <span className="size-1.5 rounded-full bg-[#4ADE80]" /> {formatVcDuration(vcElapsedSec)}
                </span>
              )}
            </div>

            {!inVoiceChannel ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
                <Volume2 className="size-12 text-[#8B93A1]/40" />
                <p className="text-sm text-[#8B93A1]">Not connected to this voice channel</p>
                <Button onClick={() => void joinVoiceChannel(guildId, activeChannel.id)}>
                  Join Voice
                </Button>
              </div>
            ) : (
              <div className="relative flex flex-1 flex-col overflow-hidden bg-[#0F1217]">
                {/* Participant grid — Discord-style: video tile or
                    avatar-with-speaking-ring per person, auto-fitting the
                    available space instead of a fixed column count. */}
                <div className="noschat-scroll flex-1 overflow-y-auto p-4 pb-28">
                  {(() => {
                    const sharingSelf = voice.screenSharing;
                    const sharingPeerId = voice.screenSharingPeerIds.find((id) => voice.peers[id]);
                    const spotlightId = sharingSelf ? "__me" : sharingPeerId;
                    if (!spotlightId) {
                      return (
                        <div
                          className="grid h-full auto-rows-fr gap-3"
                          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
                        >
                          <VoiceTile
                            seed={myId ?? "me"}
                            label="You"
                            stream={voice.localStream}
                            isLocal
                            micMuted={voice.micMuted}
                          />
                          {Object.entries(voice.peers).map(([userId, peer]) => (
                            <VoiceTile
                              key={userId}
                              seed={userId}
                              label={nameFor(userId)}
                              stream={peer.stream}
                              micMuted={peer.connectionState !== "connected"}
                              deafened={voice.deafened}
                            />
                          ))}
                        </div>
                      );
                    }
                    // Discord-style spotlight: whoever's screen-sharing (self
                    // or a peer) takes the large tile, everyone else lines
                    // up in a scrollable strip beneath it.
                    const others = [
                      { id: "__me", isLocal: true },
                      ...Object.keys(voice.peers).map((id) => ({ id, isLocal: false })),
                    ].filter((p) => p.id !== spotlightId);
                    return (
                      <div className="flex h-full flex-col gap-3">
                        <div className="min-h-0 flex-1">
                          {spotlightId === "__me" ? (
                            <VoiceTile
                              seed={myId ?? "me"}
                              label="You"
                              stream={voice.localStream}
                              isLocal
                              micMuted={voice.micMuted}
                              spotlight
                              screenSharing
                            />
                          ) : (
                            <VoiceTile
                              seed={spotlightId}
                              label={nameFor(spotlightId)}
                              stream={voice.peers[spotlightId]?.stream}
                              micMuted={voice.peers[spotlightId]?.connectionState !== "connected"}
                              deafened={voice.deafened}
                              spotlight
                              screenSharing
                            />
                          )}
                        </div>
                        {others.length > 0 && (
                          <div className="noschat-scroll flex h-28 flex-none gap-2 overflow-x-auto">
                            {others.map((p) =>
                              p.isLocal ? (
                                <div key="__me" className="aspect-video h-full flex-none">
                                  <VoiceTile
                                    seed={myId ?? "me"}
                                    label="You"
                                    stream={voice.localStream}
                                    isLocal
                                    micMuted={voice.micMuted}
                                  />
                                </div>
                              ) : (
                                <div key={p.id} className="aspect-video h-full flex-none">
                                  <VoiceTile
                                    seed={p.id}
                                    label={nameFor(p.id)}
                                    stream={voice.peers[p.id]?.stream}
                                    micMuted={voice.peers[p.id]?.connectionState !== "connected"}
                                    deafened={voice.deafened}
                                  />
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Fixed bottom control bar — always visible over the grid,
                    matching Discord's call controls (mute, deafen, camera,
                    screen-share, disconnect). */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-5">
                  <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/[0.06] bg-[#1B1F27]/95 px-3 py-2.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.6)] backdrop-blur-sm">
                    <Button
                      size="icon-lg"
                      variant={voice.micMuted ? "destructive" : "secondary"}
                      onClick={toggleMic}
                      title={voice.micMuted ? "Unmute" : "Mute"}
                    >
                      {voice.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                    </Button>
                    <Button
                      size="icon-lg"
                      variant={voice.deafened ? "destructive" : "secondary"}
                      onClick={toggleDeafen}
                      title={voice.deafened ? "Undeafen" : "Deafen"}
                    >
                      <Headphones className="size-4" />
                    </Button>
                    <Button
                      size="icon-lg"
                      variant={voice.cameraOn ? "default" : "secondary"}
                      onClick={() => void toggleCamera()}
                      title={voice.cameraOn ? "Turn Camera Off" : "Turn Camera On"}
                    >
                      {voice.cameraOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}
                    </Button>
                    <Button
                      size="icon-lg"
                      variant={voice.screenSharing ? "default" : "secondary"}
                      onClick={() => void toggleScreenShare()}
                      title={voice.screenSharing ? "Stop Screen Share" : "Share Screen"}
                    >
                      <ScreenShare className="size-4" />
                    </Button>
                    <div className="mx-1 h-6 w-px bg-white/[0.08]" />
                    <Button size="icon-lg" variant="destructive" onClick={leaveVoiceChannel} title="Disconnect">
                      <PhoneOff className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {addChannelCategoryId !== undefined && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setAddChannelCategoryId(undefined)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-xl italic text-[#E8EAED]">New Channel</h3>
              <button
                onClick={() => setAddChannelCategoryId(undefined)}
                className="flex size-7 items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
              >
                <X className="size-4" />
              </button>
            </div>
            <form onSubmit={handleCreateChannel} className="space-y-3">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setNewChannelKind("text")}
                  data-active={newChannelKind === "text"}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#2A2F3A] py-2 text-sm text-[#8B93A1] data-[active=true]:border-[#F0A868]/50 data-[active=true]:text-[#F0A868]"
                >
                  <Hash className="size-4" /> Text
                </button>
                <button
                  type="button"
                  onClick={() => setNewChannelKind("voice")}
                  data-active={newChannelKind === "voice"}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#2A2F3A] py-2 text-sm text-[#8B93A1] data-[active=true]:border-[#F0A868]/50 data-[active=true]:text-[#F0A868]"
                >
                  <Volume2 className="size-4" /> Voice
                </button>
              </div>
              <Input
                autoFocus
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                placeholder="new-channel"
                className="h-10 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-[#E8EAED] placeholder:text-[#8B93A1]/60"
              />
              {channelActionError && <p className="text-xs text-[#EB5757]">{channelActionError}</p>}
              <Button type="submit" disabled={creatingChannel || !newChannelName.trim()} className="w-full">
                {creatingChannel ? "Creating…" : "Create Channel"}
              </Button>
            </form>
          </div>
        </div>
      )}

      {addCategoryOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setAddCategoryOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-xl italic text-[#E8EAED]">New Category</h3>
              <button
                onClick={() => setAddCategoryOpen(false)}
                className="flex size-7 items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
              >
                <X className="size-4" />
              </button>
            </div>
            <form onSubmit={handleCreateCategory} className="space-y-3">
              <Input
                autoFocus
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="NEW CATEGORY"
                className="h-10 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-[#E8EAED] placeholder:text-[#8B93A1]/60"
              />
              {channelActionError && <p className="text-xs text-[#EB5757]">{channelActionError}</p>}
              <Button type="submit" disabled={creatingCategory || !newCategoryName.trim()} className="w-full">
                {creatingCategory ? "Creating…" : "Create Category"}
              </Button>
            </form>
          </div>
        </div>
      )}

      {searchOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/75 p-4 pt-20 backdrop-blur-[2px]"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-[#1D2129] bg-[#161A20] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Search className="size-4 flex-none text-[#8B93A1]" />
              <Input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSearch();
                  if (e.key === "Escape") setSearchOpen(false);
                }}
                placeholder="Search messages in this server…"
                className="h-9 flex-1 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-sm text-[#E8EAED]"
              />
              <Button size="sm" onClick={() => void handleSearch()} disabled={searching}>
                {searching ? "…" : "Search"}
              </Button>
            </div>
            <div className="mt-3 max-h-[50vh] space-y-1.5 overflow-y-auto">
              {searching && <p className="py-4 text-center text-sm text-[#8B93A1]">Searching…</p>}
              {!searching && searchQuery.trim() && searchResults.length === 0 && (
                <p className="py-4 text-center text-sm text-[#8B93A1]">No messages found.</p>
              )}
              {searchResults.map((m) => {
                const ch = detail?.channels.find((c) => c.id === m.channel_id);
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      if (ch) selectChannel(ch);
                      setSearchOpen(false);
                    }}
                    className="block w-full rounded-lg border border-[#1D2129] bg-[#12151B] px-3 py-2 text-left transition-colors hover:border-[#3A4050]"
                  >
                    <p className="flex items-center gap-1.5 text-xs text-[#8B93A1]">
                      <Hash className="size-3" />
                      {ch?.name ?? "unknown-channel"}
                      <span className="text-[#5A6272]">·</span>
                      <span className="font-medium text-[#C7CDD6]">{nameFor(m.sender_id)}</span>
                    </p>
                    <p className="mt-0.5 truncate text-sm text-[#E8EAED]">{m.content}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {editingChannel && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setEditingChannel(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <h3 className="mb-1 font-display text-xl italic text-[#E8EAED]">
              #{editingChannel.name} Settings
            </h3>
            <p className="mb-4 text-xs text-[#8B93A1]">Real, server-enforced channel settings.</p>

            <div className="space-y-4">
              {editingChannel.kind === "text" && (
                <>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                      Slow Mode
                    </label>
                    <select
                      value={editingChannel.slow_mode_seconds}
                      onChange={(e) => setEditingChannel({ ...editingChannel, slow_mode_seconds: Number(e.target.value) })}
                      className="w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217] px-3 py-2 text-sm text-[#E8EAED] outline-none focus:border-[#F0A868]/50"
                    >
                      <option value={0}>Off</option>
                      <option value={5}>5 seconds</option>
                      <option value={10}>10 seconds</option>
                      <option value={15}>15 seconds</option>
                      <option value={30}>30 seconds</option>
                      <option value={60}>1 minute</option>
                      <option value={300}>5 minutes</option>
                      <option value={900}>15 minutes</option>
                      <option value={3600}>1 hour</option>
                      <option value={21600}>6 hours</option>
                    </select>
                    <p className="mt-1 text-[11px] text-[#8B93A1]">
                      Members must wait between messages. Enforced by the server, not just the UI. Moderators bypass it.
                    </p>
                  </div>
                  <label className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={editingChannel.is_nsfw}
                      onChange={(e) => setEditingChannel({ ...editingChannel, is_nsfw: e.target.checked })}
                      className="size-4 rounded border-[#2A2F3A] bg-[#0F1217] accent-[#F0A868]"
                    />
                    <span className="text-sm text-[#E8EAED]">Age-Restricted (NSFW) Channel</span>
                  </label>
                </>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditingChannel(null)}>
                Cancel
              </Button>
              <Button
                disabled={channelSettingsSaving}
                onClick={async () => {
                  setChannelSettingsSaving(true);
                  try {
                    const token = await getToken();
                    if (token) {
                      await updateGuildChannel(token, guildId, editingChannel.id, {
                        slow_mode_seconds: editingChannel.slow_mode_seconds,
                        is_nsfw: editingChannel.is_nsfw,
                      });
                      await refreshDetail();
                    }
                    setEditingChannel(null);
                  } catch (err) {
                    setLoadError(err instanceof Error ? err.message : "Failed to update channel");
                  } finally {
                    setChannelSettingsSaving(false);
                  }
                }}
              >
                {channelSettingsSaving ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteChannel && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setPendingDeleteChannel(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <h3 className="mb-2 font-display text-xl italic text-[#E8EAED]">
              Delete #{pendingDeleteChannel.name}?
            </h3>
            <p className="mb-4 text-sm text-[#8B93A1]">
              This will permanently delete the channel and its message history. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPendingDeleteChannel(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDeleteChannel} disabled={deletingChannel}>
                {deletingChannel ? "Deleting…" : "Delete Channel"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {leaveOrDeleteOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onClick={() => setLeaveOrDeleteOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <h3 className="mb-2 font-display text-xl italic text-[#E8EAED]">
              {isOwner ? `Delete ${detail.name}?` : `Leave ${detail.name}?`}
            </h3>
            <p className="mb-4 text-sm text-[#8B93A1]">
              {isOwner
                ? "This will permanently delete the server for all members. This cannot be undone."
                : "You can rejoin later with a new invite."}
            </p>
            {leaveOrDeleteError && <p className="mb-3 text-xs text-[#EB5757]">{leaveOrDeleteError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setLeaveOrDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleLeaveOrDeleteGuild}
                disabled={leavingOrDeleting}
              >
                {leavingOrDeleting ? "Working…" : isOwner ? "Delete Server" : "Leave Server"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={pendingDeleteMessage !== null}
        title="Delete message?"
        description="This can't be undone."
        confirmLabel="Delete"
        busy={deletingMessage}
        onConfirm={() => void confirmDeleteMessage()}
        onCancel={() => setPendingDeleteMessage(null)}
      />
    </div>
  );
}
