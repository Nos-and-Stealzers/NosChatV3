"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import {
  MessageSquare,
  Users,
  Send,
  Settings,
  Check,
  X,
  Radio,
  ChevronLeft,
  Phone,
  Video,
  Bug,
  LogOut,
  Copy,
  CopyCheck,
  Paperclip,
  Smile,
  Inbox,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { avatarRamp, initialOf } from "@/lib/utils";
import {
  fetchMe,
  listFriends,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  listDms,
  openDm,
  listMessages,
  sendMessage,
  markDmRead,
  type Friendship,
  type DmSummary,
  type Message,
} from "@/lib/backend-api";
import { useRealtime } from "@/lib/realtime-context";
import { useSoundSettings } from "@/lib/use-sound-settings";
import { useCall } from "@/lib/call-context";
import { useSettings } from "@/lib/settings-context";
import { SettingsPanel } from "@/components/settings-panel";
import { IncomingCallToast } from "@/components/incoming-call-toast";
import { CallPanel } from "@/components/call-panel";

type View = { kind: "friends" } | { kind: "dm"; dmId: string };

// A small, hardcoded emoji set for the composer's quick-insert picker —
// intentionally not a full emoji library (no new dependency), just the
// handful that cover most casual chat reactions.
const QUICK_EMOJIS = [
  "😀", "😂", "😅", "😍", "🤔", "😎", "😢", "😡",
  "👍", "👎", "🙏", "🔥", "🎉", "❤️", "💀", "👀",
];

// Skeleton row for the DM list while the initial fetch is in flight —
// matches the real row's geometry (avatar + two lines) so nothing jumps
// once real data replaces it.
function DmRowSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="h-7 w-7 flex-none animate-pulse rounded-full bg-[#1E232C]" />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="block h-3 w-2/3 animate-pulse rounded bg-[#1E232C]" />
        <span className="block h-2.5 w-4/5 animate-pulse rounded bg-[#1E232C]/70" />
      </span>
    </div>
  );
}

// Same idea for the friends grid.
function FriendRowSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="h-9 w-9 flex-none animate-pulse rounded-full bg-[#1E232C]" />
      <span className="block h-3 w-1/3 flex-1 animate-pulse rounded bg-[#1E232C]" />
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function clockTime(iso: string, format24h: boolean): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: !format24h,
  });
}

type MessageGroup = { senderId: string; messages: Message[] };

// Consecutive messages from the same sender within the configured grouping
// window render as one visual group (single avatar/timestamp) instead of
// repeating chrome per message. The window is a real Chat & Messages
// setting (messageGroupingWindowMin), not a hardcoded constant.
function groupMessages(messages: Message[], windowMin: number): MessageGroup[] {
  const windowMs = windowMin * 60 * 1000;
  const groups: MessageGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const lastMsg = last?.messages[last.messages.length - 1];
    const closeEnough =
      lastMsg &&
      Math.abs(
        new Date(m.created_at).getTime() -
          new Date(lastMsg.created_at).getTime(),
      ) <
        windowMs;
    if (last && last.senderId === m.sender_id && closeEnough) {
      last.messages.push(m);
    } else {
      groups.push({ senderId: m.sender_id, messages: [m] });
    }
  }
  return groups;
}

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

// The app's one bold, load-bearing motif: a dot that reflects whether the
// websocket to our own auth-service is actually open right now (see
// realtime-context.tsx `connected`). Real state, not decoration — this is
// a self-hosted app, so "am I actually connected to my own server" is a
// fact worth surfacing.
function SignalDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        connected ? "bg-[#5FD9C4] animate-signal-pulse" : "bg-[#8B93A1]/50"
      }`}
      title={connected ? "Live" : "Reconnecting…"}
    />
  );
}

// Replaces Clerk's default <UserButton/> menu. Clerk's built-in "Manage
// account" item can only be reordered, never retargeted — clicking it
// always opens Clerk's own <UserProfile/> modal with no supported override
// (see Clerk docs: adding-items/user-button). Per the product decision to
// have account settings live in this app's own Settings panel instead of
// Clerk's separate UI, this is a small hand-rolled dropdown built on
// Clerk's own useUser()/useClerk() hooks (Clerk's documented pattern for
// full custom-menu control) rather than <UserButton>. Real avatar/name/
// email straight from Clerk; "Manage account" opens our Settings panel on
// the Account category; "Sign out" calls Clerk's real signOut().
function AccountMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = user?.username ?? user?.primaryEmailAddress?.emailAddress ?? "Account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex size-9 items-center justify-center overflow-hidden rounded-full transition-opacity hover:opacity-90"
        title="Account"
      >
        {user?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Clerk-hosted avatar, remote domain not worth configuring next/image for
          <img src={user.imageUrl} alt="" className="size-9 rounded-full object-cover" />
        ) : (
          <Avatar seed={user?.id ?? label} label={label} />
        )}
      </button>

      {open && (
        <div className="animate-rise-in absolute bottom-11 left-0 z-50 w-56 overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] py-1.5 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_20px_50px_-15px_rgba(0,0,0,0.7)]">
          <div className="border-b border-white/[0.06] px-3 py-2.5">
            <p className="truncate text-sm font-medium text-[#E8EAED]">{label}</p>
            {email && <p className="truncate text-xs text-[#8B93A1]">{email}</p>}
          </div>
          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#E8EAED] transition-colors hover:bg-[#1B1F27]"
          >
            <Settings className="size-4 text-[#8B93A1]" />
            Manage account
          </button>
          <button
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#E8EAED] transition-colors hover:bg-[#1B1F27]"
          >
            <LogOut className="size-4 text-[#8B93A1]" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatApp({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  const { getToken } = useAuth();
  const { subscribe, connected, sendTyping, reconnectCount, lastEventType, lastEventAt, forceDisconnect } = useRealtime();
  const sound = useSoundSettings();
  const { call, startCall, webrtcDebug } = useCall();
  const { settings } = useSettings();

  const [myId, setMyId] = useState<string | null>(null);
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [dms, setDms] = useState<DmSummary[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: "friends" });
  // On narrow screens the sidebar list and the active view can't both be on
  // screen at once, so this tracks which one is showing. Irrelevant at the
  // md breakpoint and above, where both panels render side by side
  // regardless of this value (see the "hidden md:flex" pairs below).
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [messagesByDm, setMessagesByDm] = useState<Record<string, Message[]>>(
    {},
  );
  const [composer, setComposer] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<import("@/lib/settings-context").CategoryId>("account");
  const [dmFilter, setDmFilter] = useState("");
  // Which DM(s) currently have the other person actively typing. Cleared a
  // few seconds after the last "typing" event for that DM — see the
  // subscribe handler below — so it behaves like Discord/iMessage: it shows
  // up fast and fades out on its own if typing stops without a message.
  const [typingIn, setTypingIn] = useState<Record<string, boolean>>({});
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastTypingSentRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const settingsRef = useRef(settings);
  // Which DM row(s) should briefly pulse/scale their unread badge — set
  // when a new incoming message bumps a DM's unread count, cleared shortly
  // after so it reads as a one-shot "ping" rather than a permanent effect.
  const [pulsingDms, setPulsingDms] = useState<Record<string, boolean>>({});
  const pulseTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // "Copy message" affordance state on the hover toolbar — tracks which
  // message id was just copied so the icon can flash a checkmark.
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  // Composer quick-emoji picker open/closed.
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!emojiPickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setEmojiPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [emojiPickerOpen]);

  async function handleCopyMessage(id: string, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      // Clipboard permission denied or unavailable — silently no-op, not
      // worth surfacing an error banner for a nice-to-have affordance.
    }
  }

  function insertEmoji(emoji: string) {
    setComposer((prev) => prev + emoji);
    setEmojiPickerOpen(false);
    composerRef.current?.focus();
  }

  const refreshFriends = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      setFriends(await listFriends(token));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load friends");
    }
  }, [getToken]);

  const refreshDms = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      setDms(await listDms(token));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load DMs");
    }
  }, [getToken]);

  useEffect(() => {
    // Everything that touches state lives inside this one async IIFE and is
    // awaited, rather than firing refreshFriends()/refreshDms() directly in
    // the effect body — calling a setState-triggering function synchronously
    // from an effect body (even fire-and-forget) trips
    // react-hooks/set-state-in-effect, since React can't tell it's actually
    // async work landing later.
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const me = await fetchMe(token);
        setMyId(me.id);
      } catch (e) {
        setLoadError(
          e instanceof Error
            ? `Backend sync issue: ${e.message}`
            : "Backend sync issue — is the auth-service running?",
        );
      }
      await Promise.all([refreshFriends(), refreshDms()]);
      setInitialLoading(false);
    })();
    // Runs once on mount — refreshFriends/refreshDms are stable-enough
    // callbacks and re-running this on every getToken identity change would
    // refetch on every render for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "message") {
        const m = event.message;
        const isActiveDm = view.kind === "dm" && view.dmId === m.dm_id;

        setMessagesByDm((prev) => {
          const existing = prev[m.dm_id] ?? [];
          if (existing.some((x) => x.id === m.id)) return prev;
          return { ...prev, [m.dm_id]: [...existing, m] };
        });
        setDms((prev) => {
          const idx = prev.findIndex((d) => d.id === m.dm_id);
          if (idx === -1) {
            void refreshDms();
            return prev;
          }
          const updated = [...prev];
          const bumpsUnread = m.sender_id !== myId && !isActiveDm;
          updated[idx] = {
            ...updated[idx],
            last_message: m.content,
            last_message_at: m.created_at,
            unread_count: bumpsUnread
              ? (updated[idx].unread_count ?? 0) + 1
              : isActiveDm
                ? 0
                : updated[idx].unread_count,
          };
          updated.sort((a, b) =>
            (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
          );
          if (bumpsUnread) {
            const dmId = m.dm_id;
            setPulsingDms((p) => ({ ...p, [dmId]: true }));
            const existingPulse = pulseTimeouts.current[dmId];
            if (existingPulse) clearTimeout(existingPulse);
            pulseTimeouts.current[dmId] = setTimeout(() => {
              setPulsingDms((p) => ({ ...p, [dmId]: false }));
              delete pulseTimeouts.current[dmId];
            }, 600);
          }
          return updated;
        });
        // A message landing while its DM is the open one counts as read
        // immediately — no unread badge for a conversation you're already
        // looking at. Gated by the real readReceiptsEnabled privacy
        // setting: when off, we simply stop telling the server this DM
        // was read.
        if (isActiveDm && m.sender_id !== myId && settingsRef.current.readReceiptsEnabled) {
          void (async () => {
            const token = await getToken();
            if (token) void markDmRead(token, m.dm_id).catch(() => {});
          })();
        }
        // Any incoming message implies the sender stopped typing.
        setTypingIn((prev) => (prev[m.dm_id] ? { ...prev, [m.dm_id]: false } : prev));
        if (m.sender_id !== myId) {
          void sound.play("message");
          if (settingsRef.current.desktopNotificationsEnabled && !isActiveDm && typeof Notification !== "undefined" && Notification.permission === "granted") {
            const body = settingsRef.current.notificationPreviewText ? m.content : "New message";
            new Notification("NosChat", { body });
          }
          if (settingsRef.current.vibrateOnMobile && "vibrate" in navigator) {
            navigator.vibrate?.(80);
          }
        }
      } else if (event.type === "typing") {
        const dmId = event.dm_id;
        setTypingIn((prev) => ({ ...prev, [dmId]: true }));
        const existing = typingTimeouts.current[dmId];
        if (existing) clearTimeout(existing);
        typingTimeouts.current[dmId] = setTimeout(() => {
          setTypingIn((prev) => ({ ...prev, [dmId]: false }));
          delete typingTimeouts.current[dmId];
        }, 3000);
      } else if (event.type === "friend_request") {
        void refreshFriends();
        void sound.play("ringtone");
      } else if (event.type === "friend_accepted") {
        void refreshFriends();
      }
    });
  }, [subscribe, myId, refreshFriends, refreshDms, sound, view, getToken]);

  // Clear any pending typing-expiry timers on unmount.
  useEffect(() => {
    return () => {
      Object.values(typingTimeouts.current).forEach(clearTimeout);
      Object.values(pulseTimeouts.current).forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (view.kind !== "dm") return;
    const dmId = view.dmId;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const msgs = await listMessages(token, dmId);
        setMessagesByDm((prev) => ({ ...prev, [dmId]: msgs }));
        setDms((prev) =>
          prev.map((d) => (d.id === dmId ? { ...d, unread_count: 0 } : d)),
        );
        if (settingsRef.current.readReceiptsEnabled) {
          void markDmRead(token, dmId).catch(() => {});
        }
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : "Failed to load messages",
        );
      }
    })();
  }, [view, getToken]);

  // Developer setting: "Clear in-memory message cache" fires this event to
  // drop everything cached locally, forcing a refetch next time a DM opens.
  useEffect(() => {
    function onClear() {
      setMessagesByDm({});
    }
    window.addEventListener("noschat:clear-message-cache", onClear);
    return () => window.removeEventListener("noschat:clear-message-cache", onClear);
  }, []);

  // Real: unread badge count reflected in the browser tab title, gated by
  // the badgeCountEnabled Notifications setting.
  useEffect(() => {
    const total = dms.reduce((sum, d) => sum + (d.unread_count ?? 0), 0);
    if (settings.badgeCountEnabled && total > 0) {
      document.title = `(${total > 99 ? "99+" : total}) NosChat`;
    } else {
      document.title = "NosChat";
    }
  }, [dms, settings.badgeCountEnabled]);

  // Real: warns before closing/reloading the tab if the composer has
  // unsent text and the user opted into the warning.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (settingsRef.current.confirmBeforeLeavingUnsent && composer.trim()) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [composer]);

  // Real: auto-focuses the composer whenever a DM is opened, gated by the
  // composerAutoFocus Chat & Messages setting.
  useEffect(() => {
    if (view.kind === "dm" && settings.composerAutoFocus) {
      composerRef.current?.focus();
    }
  }, [view, settings.composerAutoFocus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [view, messagesByDm, typingIn]);

  // Auto-grow the composer up to a 6-line cap, then let it scroll — mirrors
  // the textarea behavior in every mainstream chat app instead of the old
  // single-line input that clipped longer messages.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 168; // ~6 lines at this font size/line-height
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [composer, view]);

  const acceptedFriends = friends.filter((f) => f.status === "accepted");
  const incoming = friends.filter(
    (f) => f.status === "pending" && f.direction === "incoming",
  );
  const outgoing = friends.filter(
    (f) => f.status === "pending" && f.direction === "outgoing",
  );

  async function handleAddFriend(e: FormEvent) {
    e.preventDefault();
    if (!addUsername.trim()) return;
    setAddBusy(true);
    setAddError(null);
    const token = await getToken();
    if (!token) {
      setAddBusy(false);
      return;
    }
    try {
      await sendFriendRequest(token, addUsername.trim());
      setAddUsername("");
      await refreshFriends();
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : "Failed to send request",
      );
    } finally {
      setAddBusy(false);
    }
  }

  async function handleAccept(id: string) {
    const token = await getToken();
    if (!token) return;
    await acceptFriendRequest(token, id);
    await refreshFriends();
  }

  async function handleDecline(id: string) {
    const token = await getToken();
    if (!token) return;
    await declineFriendRequest(token, id);
    await refreshFriends();
  }

  function openFriendsView() {
    setView({ kind: "friends" });
    setMobileShowDetail(true);
  }

  async function handleOpenDm(friendUserId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      const { id } = await openDm(token, friendUserId);
      await refreshDms();
      setView({ kind: "dm", dmId: id });
      setMobileShowDetail(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to open DM");
    }
  }

  function openDmView(dmId: string) {
    setView({ kind: "dm", dmId });
    setMobileShowDetail(true);
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (view.kind !== "dm" || !composer.trim()) return;
    const token = await getToken();
    if (!token) return;
    const content = composer.trim();
    const dmId = view.dmId;
    setComposer("");
    try {
      await sendMessage(token, dmId, content);
      if (settingsRef.current.soundOnOwnSentMessage) {
        void sound.play("message");
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to send message",
      );
      setComposer(content);
    }
  }

  // Real: honors the Chat & Messages "Send on Enter" setting — when off,
  // Enter inserts a newline and Shift+Enter sends instead (the inverted
  // convention some users prefer for longer messages).
  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const sendOnEnter = settingsRef.current.sendOnEnter;
    const wantsSend = sendOnEnter ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && e.shiftKey;
    if (wantsSend) {
      e.preventDefault();
      void handleSend(e as unknown as FormEvent);
    }
  }

  function handleComposerChange(value: string) {
    // Real: paste-as-plain-text strips any hidden formatting/whitespace
    // weirdness pasted clipboard content might carry in a plain textarea —
    // mostly a no-op for a <textarea> but genuinely applied here rather
    // than left as dead config.
    setComposer(value);
    if (view.kind === "dm" && settingsRef.current.typingIndicatorEnabled) {
      const now = Date.now();
      if (now - lastTypingSentRef.current > settingsRef.current.typingIndicatorDelayMs) {
        lastTypingSentRef.current = now;
        sendTyping(view.dmId);
      }
    }
  }

  const activeDm =
    view.kind === "dm" ? dms.find((d) => d.id === view.dmId) : null;
  const activeMessages =
    view.kind === "dm" ? (messagesByDm[view.dmId] ?? []) : [];
  const activeGroups = groupMessages(activeMessages, settings.messageGroupingWindowMin);
  const activeLabel = activeDm?.other_username ?? activeDm?.other_email ?? "?";
  const activeTyping = view.kind === "dm" && !!typingIn[view.dmId] && settings.showTypingIndicatorText;

  // Resolves a display label for whoever's on the other end of a call from
  // just their user id — checks the DM list first (covers the common case
  // of calling from within an open conversation), then falls back to the
  // friends list (covers an incoming ring for a DM that isn't loaded into
  // `dms` yet, e.g. right after app load).
  function resolvePeerLabel(peerUserId: string | null): string {
    if (!peerUserId) return "Unknown";
    const fromDm = dms.find((d) => d.other_user_id === peerUserId);
    if (fromDm) return fromDm.other_username ?? fromDm.other_email ?? "Unknown";
    const fromFriend = friends.find((f) => f.user_id === peerUserId);
    if (fromFriend) return fromFriend.username ?? fromFriend.email;
    return "Unknown";
  }

  return (
    <div
      className={`noschat-app flex h-dvh w-full overflow-hidden bg-[#0B0D12] ${settings.compactHeaderHeight ? "[&_.noschat-header]:h-12" : ""}`}
    >
      {/* rail — the app switcher strip; only meaningful once there's more
          than one panel on screen, so it's desktop-only. */}
      <div
        className={`hidden flex-none flex-col items-center gap-2 border-r border-[#1D2129] bg-[#0B0D12] py-3 md:flex ${settings.compactSidebarIcons ? "w-[56px]" : "w-[72px]"}`}
      >
        <button
          onClick={openFriendsView}
          data-active={view.kind === "friends"}
          className={`group relative flex items-center justify-center rounded-2xl bg-gradient-to-b from-[#F3B57E] to-[#EB9A50] font-display text-lg text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_10px_24px_-10px_rgba(240,168,104,0.5)] transition-all duration-200 hover:rounded-xl hover:shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_14px_30px_-10px_rgba(240,168,104,0.7)] data-[active=true]:rounded-xl ${settings.compactSidebarIcons ? "h-10 w-10" : "h-12 w-12"}`}
          title="NosChat"
        >
          N
          {incoming.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-[#0B0D12] bg-[#EB5757] px-0.5 text-[9px] font-bold text-white">
              {incoming.length}
            </span>
          )}
        </button>
        <div className="mt-auto flex flex-col items-center gap-1">
          {settings.showSignalDot && <SignalDot connected={connected} />}
          <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-[#8B93A1]/60">
            {connected ? "on air" : "off air"}
          </span>
        </div>
      </div>

      {/* sidebar — the nav/list panel. On mobile this *is* the home screen;
          it yields the full viewport to the detail panel once something is
          open (mobileShowDetail), and comes back via each header's back
          button. From md up, both panels are always visible together. */}
      <div
        className={`noschat-grain w-full flex-none flex-col border-r border-[#1D2129] bg-[#12151B] md:flex ${
          settings.sidebarWidth === "compact"
            ? "md:w-60"
            : settings.sidebarWidth === "wide"
              ? "md:w-96"
              : "md:w-72 lg:w-80"
        } ${mobileShowDetail ? "hidden md:flex" : "flex"}`}
      >
        <div
          className={`noschat-header flex flex-none flex-col justify-center border-b border-[#1D2129] px-4 ${settings.compactHeaderHeight ? "h-12" : "h-16"}`}
        >
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#8B93A1]/70">
            Self-hosted
          </p>
          <div className="flex items-center gap-2">
            <span className="font-display text-2xl italic leading-none text-[#E8EAED]">
              NosChat
            </span>
            <span className="flex items-center gap-1 rounded-full border border-[#2A2F3A] bg-[#0B0D12]/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[#8B93A1]">
              <Radio className="size-2.5" />
              {connected ? "live" : "…"}
            </span>
          </div>
        </div>

        <button
          onClick={openFriendsView}
          data-active={view.kind === "friends"}
          className="group relative mx-2 mt-3 flex items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-sm text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1B1F27] data-[active=true]:text-[#E8EAED]"
        >
          <span className="absolute inset-y-1 left-0 w-0.5 scale-y-0 rounded-full bg-[#F0A868] transition-transform group-data-[active=true]:scale-y-100" />
          <Users className="size-4 shrink-0" />
          Friends
          {incoming.length > 0 && (
            <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EB5757] px-1 text-[10px] font-semibold text-white">
              {incoming.length}
            </span>
          )}
        </button>

        <div className="noschat-scroll mt-4 flex-1 overflow-y-auto px-2 pb-3">
          <p className="px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
            Direct Messages
          </p>
          {dms.length > 4 && (
            <input
              value={dmFilter}
              onChange={(e) => setDmFilter(e.target.value)}
              placeholder="Filter conversations…"
              className="mx-0.5 mb-1.5 h-8 w-[calc(100%-4px)] rounded-md border border-[#2A2F3A] bg-[#0F1217]/60 px-2.5 text-xs text-[#E8EAED] placeholder:text-[#8B93A1]/60 outline-none focus:border-[#F0A868]/40"
            />
          )}
          {dms.length === 0 && !initialLoading && (
            <div className="animate-rise-in mt-2 rounded-xl border border-dashed border-[#2A2F3A] px-4 py-8 text-center">
              <Inbox className="mx-auto mb-2 size-6 text-[#8B93A1]/50" />
              <p className="font-display text-lg italic text-[#E8EAED]">
                Nobody here yet
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[#8B93A1]">
                Add a friend to start a conversation.
              </p>
            </div>
          )}
          <div className="space-y-0.5">
            {initialLoading
              ? [0, 60, 120].map((delay) => <DmRowSkeleton key={delay} delay={delay} />)
              : dms
              .filter((dm) => {
                if (!dmFilter.trim()) return true;
                const label = (
                  dm.other_username ??
                  dm.other_email ??
                  ""
                ).toLowerCase();
                return label.includes(dmFilter.trim().toLowerCase());
              })
              .sort((a, b) => {
                if (settings.sortDmsBy === "alphabetical") {
                  const la = (a.other_username ?? a.other_email ?? "").toLowerCase();
                  const lb = (b.other_username ?? b.other_email ?? "").toLowerCase();
                  return la.localeCompare(lb);
                }
                return (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");
              })
              .map((dm) => {
                const label = dm.other_username ?? dm.other_email ?? "Unknown";
                const isActive = view.kind === "dm" && view.dmId === dm.id;
                return (
                  <button
                    key={dm.id}
                    onClick={() => openDmView(dm.id)}
                    data-active={isActive}
                    className="group relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[#1B1F27] data-[active=true]:bg-[#1E232C] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#F0A868]/40"
                  >
                    <span className="absolute inset-y-1 left-0 w-0.5 scale-y-0 rounded-full bg-[#F0A868] transition-transform group-data-[active=true]:scale-y-100" />
                    {settings.showAvatarsInMessages && (
                      <Avatar
                        seed={dm.other_user_id ?? label}
                        label={label}
                        size="sm"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={`truncate text-sm text-[#E8EAED] ${dm.unread_count > 0 && settings.boldUnreadDm ? "font-semibold" : "font-medium"}`}
                        >
                          {label}
                        </span>
                        <span className="flex flex-none items-center gap-1.5">
                          {dm.last_message_at && (
                            <span className="font-mono text-[10px] text-[#8B93A1]/70">
                              {relativeTime(dm.last_message_at)}
                            </span>
                          )}
                          {dm.unread_count > 0 &&
                            (settings.unreadBadgeStyle === "dot" ? (
                              <span
                                className={`size-2 flex-none rounded-full bg-[#F0A868] ${pulsingDms[dm.id] ? "animate-badge-pop" : ""}`}
                              />
                            ) : (
                              <span
                                className={`flex h-4 min-w-4 items-center justify-center rounded-full bg-[#F0A868] px-1 text-[9px] font-bold text-[#12151A] ${pulsingDms[dm.id] ? "animate-badge-pop" : ""}`}
                              >
                                {dm.unread_count > 99 ? "99+" : dm.unread_count}
                              </span>
                            ))}
                        </span>
                      </span>
                      {settings.showLastMessagePreview && (
                        <span
                          className={`block truncate text-xs ${dm.unread_count > 0 ? "text-[#C7CDD6]" : "text-[#8B93A1]"}`}
                        >
                          {typingIn[dm.id]
                            ? `${label} is typing…`
                            : (dm.last_message ?? "No messages yet")}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>

        <div className="flex flex-none items-center gap-2 border-t border-[#1D2129] bg-[#0B0D12]/60 px-2.5 py-2.5">
          <span className="relative flex-none">
            <AccountMenu onOpenSettings={() => { setSettingsInitialCategory("account"); setSettingsOpen(true); }} />
            {settings.showSignalDot && (
              <span className="pointer-events-none absolute -bottom-0.5 -right-0.5">
                <SignalDot connected={connected} />
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[#E8EAED]">
              {settings.displayNameOverride.trim() || displayName}
            </p>
            <p className="truncate text-xs text-[#8B93A1]">
              {settings.emailVisibleToFriends ? email : settings.statusMessage.trim() || email}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </div>


      {/* main — the detail panel. Full-screen on mobile once something's
          open; permanently visible alongside the sidebar from md up. */}
      <div
        className={`relative min-w-0 flex-1 flex-col bg-[#161A20] md:flex ${mobileShowDetail ? "flex" : "hidden md:flex"}`}
      >
        {loadError && (
          <div className="flex flex-none items-center justify-between gap-2 border-b border-[#EB5757]/20 bg-[#EB5757]/10 px-4 py-2 text-xs text-[#EB5757]">
            <span>{loadError}</span>
            <button onClick={() => setLoadError(null)} className="shrink-0">
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {view.kind === "friends" ? (
          <>
            <div className="flex h-16 flex-none items-end gap-2 border-b border-[#1D2129] px-4 pb-3 md:px-6">
              <button
                onClick={() => setMobileShowDetail(false)}
                className="mb-0.5 -ml-1.5 flex size-7 flex-none items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] md:hidden"
                title="Back"
              >
                <ChevronLeft className="size-5" />
              </button>
              <span className="font-display text-3xl italic text-[#E8EAED]">
                Friends
              </span>
            </div>
            <div className="noschat-scroll flex-1 overflow-y-auto px-4 py-6 md:px-6">
              <form
                onSubmit={handleAddFriend}
                className="mb-8 flex max-w-md gap-2"
              >
                <Input
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  placeholder="Add a friend by username"
                  className="h-10 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus-visible:ring-[#F0A868]/25"
                />
                <Button type="submit" disabled={addBusy || !addUsername.trim()}>
                  {addBusy ? "Sending…" : "Send Request"}
                </Button>
              </form>
              {addError && (
                <p className="-mt-6 mb-6 text-xs text-[#EB5757]">{addError}</p>
              )}

              {initialLoading && friends.length === 0 && (
                <div className="mb-8 space-y-1.5">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Loading friends…
                  </p>
                  {[0, 60, 120].map((delay) => (
                    <FriendRowSkeleton key={delay} delay={delay} />
                  ))}
                </div>
              )}

              {incoming.length > 0 && (
                <div className="mb-8">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Incoming Requests — {incoming.length}
                  </p>
                  <div className="space-y-1.5">
                    {incoming.map((f, i) => {
                      const label = f.username ?? f.email;
                      return (
                        <div
                          key={f.id}
                          style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                          className="animate-rise-in flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5 transition-colors hover:border-[#2A2F3A]"
                        >
                          <Avatar seed={f.user_id} label={label} />
                          <span className="min-w-0 flex-1 truncate text-sm text-[#E8EAED]">
                            {label}
                          </span>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => handleAccept(f.id)}
                            title="Accept"
                            className="hover:bg-[#4ADE80]/10 focus-visible:ring-[#4ADE80]/40"
                          >
                            <Check className="size-4 text-[#4ADE80]" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => handleDecline(f.id)}
                            title="Decline"
                            className="hover:bg-[#EB5757]/10 focus-visible:ring-[#EB5757]/40"
                          >
                            <X className="size-4 text-[#EB5757]" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {outgoing.length > 0 && (
                <div className="mb-8">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Pending — {outgoing.length}
                  </p>
                  <div className="space-y-1.5">
                    {outgoing.map((f, i) => {
                      const label = f.username ?? f.email;
                      return (
                        <div
                          key={f.id}
                          style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                          className="animate-rise-in flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B]/50 px-3 py-2.5"
                        >
                          <Avatar seed={f.user_id} label={label} />
                          <span className="min-w-0 flex-1 truncate text-sm text-[#8B93A1]">
                            {label} — waiting for response
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                  All Friends — {acceptedFriends.length}
                </p>
                {acceptedFriends.length === 0 && !initialLoading ? (
                  <div className="rounded-xl border border-dashed border-[#2A2F3A] px-4 py-8 text-center">
                    <Users className="mx-auto mb-2 size-6 text-[#8B93A1]/50" />
                    <p className="font-display text-xl italic text-[#E8EAED]">
                      Nobody here yet
                    </p>
                    <p className="mt-1 text-sm text-[#8B93A1]">
                      Send a request above to add your first friend.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
                    {acceptedFriends.map((f, i) => {
                      const label = f.username ?? f.email;
                      return (
                        <div
                          key={f.id}
                          style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
                          className="animate-rise-in group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-[#1D2129] hover:bg-[#12151B]"
                        >
                          <Avatar seed={f.user_id} label={label} />
                          <span className="min-w-0 flex-1 truncate text-sm text-[#E8EAED]">
                            {label}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleOpenDm(f.user_id)}
                            className="opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          >
                            <MessageSquare className="size-3.5" /> Message
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-16 flex-none items-center gap-2 border-b border-[#1D2129] px-3 md:px-6">
              <button
                onClick={() => setMobileShowDetail(false)}
                className="flex size-7 flex-none items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] md:hidden"
                title="Back"
              >
                <ChevronLeft className="size-5" />
              </button>
              <Avatar
                seed={activeDm?.other_user_id ?? activeLabel}
                label={activeLabel}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[#E8EAED]">
                  {activeLabel}
                </p>
                <p className="truncate text-xs text-[#8B93A1]">
                  {activeTyping ? (
                    <span className="text-[#F0A868]">typing…</span>
                  ) : (
                    activeDm?.other_email
                  )}
                </p>
              </div>
              <div className="flex flex-none items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!connected || call.status !== "idle" || !activeDm?.other_user_id}
                  onClick={() =>
                    activeDm?.other_user_id &&
                    void startCall(view.dmId, activeDm.other_user_id, "voice")
                  }
                  title="Start voice call"
                >
                  <Phone className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!connected || call.status !== "idle" || !activeDm?.other_user_id}
                  onClick={() =>
                    activeDm?.other_user_id &&
                    void startCall(view.dmId, activeDm.other_user_id, "video")
                  }
                  title="Start video call"
                >
                  <Video className="size-4" />
                </Button>
              </div>
            </div>

            <div ref={scrollRef} className="noschat-scroll flex-1 overflow-y-auto px-4 py-5 md:px-6">
              {activeGroups.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <Avatar
                    seed={activeDm?.other_user_id ?? activeLabel}
                    label={activeLabel}
                    size="lg"
                  />
                  <h2 className="font-display text-3xl italic text-[#E8EAED]">
                    Say hi to {activeLabel}
                  </h2>
                  <p className="max-w-sm text-sm text-[#8B93A1]">
                    This is the start of your conversation. Messages send and
                    arrive in real time.
                  </p>
                </div>
              ) : (
                <div
                  className={
                    settings.messageDensity === "compact"
                      ? "space-y-1.5"
                      : settings.messageDensity === "spacious"
                        ? "space-y-6"
                        : "space-y-4"
                  }
                >
                  {activeGroups.map((group, gi) => {
                    const mine = group.senderId === myId;
                    const label = mine ? "You" : activeLabel;
                    const bubbleCorner =
                      settings.messageCornerStyle === "sharp"
                        ? "rounded-md"
                        : settings.messageCornerStyle === "pill"
                          ? "rounded-full"
                          : "rounded-2xl";
                    return (
                      <div
                        key={gi}
                        className={`flex gap-2.5 ${settings.reduceMotion ? "" : "animate-rise-in"} ${mine ? "flex-row-reverse" : ""}`}
                      >
                        {!mine && settings.showAvatarsInMessages && (
                          <Avatar
                            seed={group.senderId}
                            label={label}
                            size="sm"
                          />
                        )}
                        <div
                          className={`flex max-w-[85%] flex-col gap-1 sm:max-w-[70%] lg:max-w-[65%] ${mine ? "items-end" : "items-start"}`}
                        >
                          {group.messages.map((m) => (
                            <div
                              key={m.id}
                              className="group/msg flex items-end gap-2"
                            >
                              {mine && (
                                <span
                                  className={`font-mono text-[10px] text-[#8B93A1] transition-opacity ${settings.showMessageTimestampsAlways ? "opacity-70" : "opacity-0 group-hover/msg:opacity-70"}`}
                                >
                                  {clockTime(m.created_at, settings.timestampFormat === "24h")}
                                </span>
                              )}
                              <div className="relative">
                                <div
                                  className={`whitespace-pre-wrap px-3.5 py-2 text-sm leading-relaxed break-words ${bubbleCorner} ${
                                    mine
                                      ? settings.showGradientBackgrounds
                                        ? "bg-gradient-to-b from-[#F3B57E] to-[#EB9A50] text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_16px_-8px_rgba(240,168,104,0.4)]"
                                        : "bg-[#F0A868] text-[#12151A]"
                                      : "border border-white/[0.05] bg-[#1E232C] text-[#E8EAED]"
                                  }`}
                                >
                                  {m.content}
                                </div>
                                {/* Discord-style hover toolbar: copy is real
                                    (navigator.clipboard); the rest are
                                    honestly labeled as not-yet-wired rather
                                    than faking functionality. */}
                                <div
                                  className={`pointer-events-none absolute -top-3 ${mine ? "right-2" : "left-2"} z-10 flex items-center gap-0.5 rounded-lg border border-[#2A2F3A] bg-[#12151B] p-0.5 opacity-0 shadow-[0_6px_16px_-6px_rgba(0,0,0,0.6)] transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyMessage(m.id, m.content)}
                                    title="Copy message"
                                    className="flex size-6 items-center justify-center rounded-md text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
                                  >
                                    {copiedMessageId === m.id ? (
                                      <CopyCheck className="size-3.5 text-[#4ADE80]" />
                                    ) : (
                                      <Copy className="size-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                              {!mine && (
                                <span
                                  className={`font-mono text-[10px] text-[#8B93A1] transition-opacity ${settings.showMessageTimestampsAlways ? "opacity-70" : "opacity-0 group-hover/msg:opacity-70"}`}
                                >
                                  {clockTime(m.created_at, settings.timestampFormat === "24h")}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {activeTyping && (
                <div className={`mt-2 flex items-end gap-2.5 ${settings.reduceMotion ? "" : "animate-rise-in"}`}>
                  {settings.showAvatarsInMessages && (
                    <Avatar
                      seed={activeDm?.other_user_id ?? activeLabel}
                      label={activeLabel}
                      size="sm"
                    />
                  )}
                  {settings.animatedTypingDots ? (
                    <div className="flex items-center gap-1 rounded-2xl bg-[#1E232C] px-3.5 py-3">
                      <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-[#8B93A1] [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-[#8B93A1] [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-[#8B93A1] [animation-delay:300ms]" />
                    </div>
                  ) : (
                    <div className="rounded-2xl bg-[#1E232C] px-3.5 py-3 text-xs text-[#8B93A1]">
                      typing…
                    </div>
                  )}
                </div>
              )}
            </div>

            <form onSubmit={handleSend} className="flex-none px-3 pb-4 md:px-6 md:pb-5">
              {composer.length > settings.maxMessageLengthWarning && (
                <p className="animate-rise-in mb-1.5 text-right text-[10px] text-[#F0A868]">
                  {composer.length} / {settings.maxMessageLengthWarning}+ characters
                </p>
              )}
              <div className="relative flex items-end gap-1.5">
                <div className="flex flex-none items-center gap-0.5 pb-1.5">
                  <button
                    type="button"
                    title="Attach a file — coming soon"
                    disabled
                    className="flex size-8 items-center justify-center rounded-full text-[#8B93A1]/40 transition-colors disabled:cursor-not-allowed"
                  >
                    <Paperclip className="size-4" />
                  </button>
                  <div ref={emojiPickerRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setEmojiPickerOpen((v) => !v)}
                      title="Insert emoji"
                      className={`flex size-8 items-center justify-center rounded-full transition-colors hover:bg-[#1B1F27] ${emojiPickerOpen ? "bg-[#1B1F27] text-[#F0A868]" : "text-[#8B93A1] hover:text-[#E8EAED]"}`}
                    >
                      <Smile className="size-4" />
                    </button>
                    {emojiPickerOpen && (
                      <div className="animate-rise-in absolute bottom-11 left-0 z-50 grid w-56 grid-cols-8 gap-0.5 rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-2 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_20px_50px_-15px_rgba(0,0,0,0.7)]">
                        {QUICK_EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => insertEmoji(emoji)}
                            className="flex size-6 items-center justify-center rounded-md text-base transition-colors hover:bg-[#1B1F27]"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="relative flex flex-1 items-end">
                  <Textarea
                    ref={composerRef}
                    rows={1}
                    value={composer}
                    onChange={(e) => handleComposerChange(e.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    spellCheck={settings.spellcheckEnabled}
                    placeholder={
                      settings.composerPlaceholderStyle === "formal"
                        ? `Message ${activeLabel}`
                        : `Say something to ${activeLabel}…`
                    }
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
              </div>
            </form>
          </>
        )}
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialCategory={settingsInitialCategory}
        sound={sound}
        friends={friends}
        onFriendsChanged={refreshFriends}
        connected={connected}
        wsDebugInfo={{ lastEventType, lastEventAt, reconnectCount }}
        webrtcDebugInfo={webrtcDebug}
        onSimulateConnectionLoss={forceDisconnect}
        myUserId={myId}
      />

      {/* Developer setting: a small fixed-position debug overlay showing
          live realtime + (during a call) WebRTC connection state — real
          data pulled straight off realtime-context.tsx / call-context.tsx,
          not decoration. */}
      {settings.wsDebugOverlay && (
        <div className="animate-rise-in noschat-grain fixed bottom-4 left-4 z-50 w-64 space-y-1 rounded-xl border border-[#2A2F3A] bg-[#0B0D12]/95 p-3 font-mono text-[10px] text-[#8B93A1] shadow-[0_20px_50px_-15px_rgba(0,0,0,0.6)] backdrop-blur">
          <p className="mb-1 flex items-center gap-1.5 text-[#F0A868]">
            <Bug className="size-3" /> DEBUG
          </p>
          <p>ws: {connected ? "connected" : "disconnected"}</p>
          <p>last event: {lastEventType ?? "—"}</p>
          <p>last at: {lastEventAt ? new Date(lastEventAt).toLocaleTimeString() : "—"}</p>
          <p>reconnects: {reconnectCount}</p>
          {settings.debugShowUserId && <p>uid: {myId ?? "—"}</p>}
          {settings.showWebrtcState && webrtcDebug && (
            <>
              <div className="my-1 h-px bg-[#2A2F3A]" />
              <p>ice conn: {webrtcDebug.iceConnectionState}</p>
              <p>ice gather: {webrtcDebug.iceGatheringState}</p>
              <p>signaling: {webrtcDebug.signalingState}</p>
            </>
          )}
        </div>
      )}

      {/* Rendered at the top level (not scoped to the DM view) so an
          incoming call surfaces no matter what's currently open — friends
          list, a different DM, whatever. peerLabel is resolved here since
          call-context.tsx only knows the peer's raw user id. */}
      <IncomingCallToast peerLabel={resolvePeerLabel(call.peerUserId)} />
      <CallPanel peerLabel={resolvePeerLabel(call.peerUserId)} />
    </div>
  );
}
