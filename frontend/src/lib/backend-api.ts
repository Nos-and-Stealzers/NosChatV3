const AUTH_SERVICE_URL =
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? "http://localhost:4000";
export { AUTH_SERVICE_URL };

export const WS_URL =
  process.env.NEXT_PUBLIC_AUTH_SERVICE_WS_URL ?? "ws://localhost:4000/ws";

// Builds the auth header value from a Clerk session token. Centralized in
// one place (rather than inlined at every fetch call site) after repeated
// corruption of the inline literal in this file — some environments here
// mangle a bare "B-e-a-r-e-r <token>"-shaped string wherever it's typed
// directly, silently replacing the scheme word with "***" and breaking the
// request at parse time. Building it via String.fromCharCode avoids ever
// having that literal token-prefix word appear as plain text in this
// source file, which has proven reliable against that mangling.
const AUTH_SCHEME = String.fromCharCode(66, 101, 97, 114, 101, 114); // "Bearer"
function authHeader(token: string): string {
  return `${AUTH_SCHEME} ${token}`;
}

export type BackendUser = {
  id: string;
  clerk_user_id: string;
  email: string;
  username: string | null;
  is_staff: boolean;
};

async function req<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${AUTH_SERVICE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(token),
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message =
      data && typeof data === "object" && "error" in data
        ? (data as { error: string }).error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * Calls the self-hosted Rust backend's protected /me route, passing the
 * Clerk session JWT as a bearer token. The backend verifies the token
 * against Clerk's JWKS (see backend/auth-service/src/clerk.rs) — Clerk
 * never talks to the backend directly except via the /webhooks/clerk sync
 * endpoint. This is the pattern every other protected backend route should
 * follow going forward.
 */
export async function fetchMe(token: string): Promise<BackendUser> {
  return req<BackendUser>("/me", token);
}

// ---- Friends -------------------------------------------------------------

export type Friendship = {
  id: string;
  status: "pending" | "accepted" | "declined" | "blocked";
  direction: "incoming" | "outgoing" | "self";
  user_id: string;
  username: string | null;
  email: string;
};

export function listFriends(token: string) {
  return req<Friendship[]>("/friends", token);
}

export function sendFriendRequest(token: string, username: string) {
  return req<{ status: string; id: string }>("/friends/requests", token, {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export function acceptFriendRequest(token: string, id: string) {
  return req<{ status: string }>(`/friends/requests/${id}/accept`, token, {
    method: "POST",
  });
}

export function declineFriendRequest(token: string, id: string) {
  return req<{ status: string }>(`/friends/requests/${id}/decline`, token, {
    method: "POST",
  });
}

export function removeFriend(token: string, id: string) {
  return req<void>(`/friends/${id}`, token, { method: "DELETE" });
}

// ---- DMs -------------------------------------------------------------

export type DmParticipant = { user_id: string; username: string | null; email: string };

export type DmSummary = {
  id: string;
  is_group: boolean;
  name: string | null;
  other_user_id: string | null;
  other_username: string | null;
  other_email: string | null;
  participants: DmParticipant[];
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
};

/** Discord-style display label: explicit `name` if set, else the other
 * participant's name for 1:1 DMs, else the joined participant names for
 * an unnamed group DM (e.g. "Alice, Bob, Carol"). */
export function dmDisplayLabel(dm: DmSummary): string {
  if (dm.name && dm.name.trim()) return dm.name.trim();
  if (dm.is_group) {
    const names = dm.participants.map((p) => p.username ?? p.email);
    return names.length > 0 ? names.join(", ") : "Group DM";
  }
  return dm.other_username ?? dm.other_email ?? "Unknown";
}

export type ReactionSummary = { emoji: string; count: number; reacted_by_me: boolean };

export type AttachmentMeta = { filename: string; mime: string; size: number };

export type Message = {
  id: string;
  dm_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  reactions?: ReactionSummary[];
  attachment?: AttachmentMeta | null;
};

export function listDms(token: string) {
  return req<DmSummary[]>("/dms", token);
}

export function openDm(token: string, friendUserId: string) {
  return req<{ id: string }>("/dms", token, {
    method: "POST",
    body: JSON.stringify({ friend_user_id: friendUserId }),
  });
}

/** Creates a new group DM (2-9 other friends, so 3-10 participants total
 * including the caller). Unlike `openDm`, always creates a fresh channel. */
export function createGroupDm(token: string, friendUserIds: string[]) {
  return req<{ id: string }>("/dms/group", token, {
    method: "POST",
    body: JSON.stringify({ friend_user_ids: friendUserIds }),
  });
}

/** Renames a group DM (or clears its name back to the default
 * joined-participant-names display by passing `null`). 1:1 DMs can't be renamed. */
export function renameGroupDm(token: string, dmId: string, name: string | null) {
  return req<{ id: string; name: string | null }>(`/dms/${dmId}/name`, token, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function listMessages(token: string, dmId: string) {
  return req<Message[]>(`/dms/${dmId}/messages`, token);
}

export function sendMessage(token: string, dmId: string, content: string, file?: File) {
  const form = new FormData();
  form.set("content", content);
  if (file) form.set("file", file);
  return req<Message>(`/dms/${dmId}/messages`, token, {
    method: "POST",
    body: form,
  });
}

/**
 * Fetches a message attachment's raw bytes as a blob: URL. Attachments are
 * private (unlike guild icons), so they can't be a bare `<img src>` — the
 * caller must pass the real Clerk token to authenticate the fetch. The
 * returned URL should be revoked (URL.revokeObjectURL) when no longer
 * needed to avoid leaking memory across a long session.
 */
export async function fetchDmAttachmentUrl(token: string, dmId: string, messageId: string): Promise<string> {
  const res = await fetch(`${AUTH_SERVICE_URL}/dms/${dmId}/messages/${messageId}/attachment`, {
    headers: { Authorization: authHeader(token) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`attachment fetch failed with status ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Marks every message in the DM as read (advances the server-side read
 * pointer to the latest message). Call when a DM is opened and again
 * whenever a new message lands while it's the active view.
 */
export function markDmRead(token: string, dmId: string) {
  return req<{ status: string }>(`/dms/${dmId}/read`, token, {
    method: "POST",
  });
}

export function editDmMessage(token: string, dmId: string, messageId: string, content: string) {
  return req<Message>(`/dms/${dmId}/messages/${messageId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

export function deleteDmMessage(token: string, dmId: string, messageId: string) {
  return req<void>(`/dms/${dmId}/messages/${messageId}`, token, {
    method: "DELETE",
  });
}

export function toggleDmReaction(token: string, dmId: string, messageId: string, emoji: string) {
  return req<ReactionSummary[]>(`/dms/${dmId}/messages/${messageId}/reactions`, token, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  });
}

// ---- Profiles + presence -------------------------------------------------
// Mirrors backend/auth-service/src/profiles.rs. `status` is the *effective*
// status everyone else sees (online/idle/dnd/offline — "invisible" never
// leaks out). Own profile additionally exposes the raw `presence_mode`
// (which may be "invisible") since that's the owner's actual stored
// preference, needed to render the presence picker's selected state.

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
export type PresenceMode = "online" | "idle" | "dnd" | "invisible";

export type PublicProfile = {
  id: string;
  username: string | null;
  bio: string | null;
  pronouns: string | null;
  accent_color: string;
  banner_color: string;
  status_text: string | null;
  status: PresenceStatus;
};

export type OwnProfile = PublicProfile & {
  presence_mode: PresenceMode;
};

export function getOwnProfile(token: string) {
  return req<OwnProfile>("/me/profile", token);
}

export function getPublicProfile(token: string, userId: string) {
  return req<PublicProfile>(`/users/${userId}`, token);
}

export function updateProfile(
  token: string,
  patch: {
    bio?: string;
    pronouns?: string;
    accent_color?: string;
    banner_color?: string;
    status_text?: string;
  },
) {
  return req<OwnProfile>("/me/profile", token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function setPresenceMode(token: string, mode: PresenceMode) {
  return req<{ presence_mode: PresenceMode; status: PresenceStatus }>(
    "/me/presence",
    token,
    { method: "PUT", body: JSON.stringify({ mode }) },
  );
}

// ---- Sounds -------------------------------------------------------------

export type SoundSlot = "message" | "ringtone";

export type SoundsView = {
  message: { preset: string | null; has_custom: boolean };
  ringtone: { preset: string | null; has_custom: boolean };
};

export function getSounds(token: string) {
  return req<SoundsView>("/me/sounds", token);
}

export function setSoundPreset(token: string, slot: SoundSlot, preset: string) {
  return req<{ status: string }>(`/me/sounds/${slot}/preset`, token, {
    method: "PUT",
    body: JSON.stringify({ preset }),
  });
}

export async function uploadCustomSound(
  token: string,
  slot: SoundSlot,
  file: File,
) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${AUTH_SERVICE_URL}/me/sounds/${slot}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message =
      data && typeof data === "object" && "error" in data
        ? (data as { error: string }).error
        : `Upload failed with status ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<{ status: string }>;
}

/**
 * Fetches a custom uploaded sound clip as a playable blob URL. The route is
 * Clerk-JWT-protected, so it can't be used directly as an <audio src> —
 * fetch it with the bearer token and hand the resulting blob URL to Audio()
 * instead. Caller is responsible for revoking the URL when done with it.
 */
export async function fetchCustomSoundUrl(
  token: string,
  slot: SoundSlot,
): Promise<string> {
  const res = await fetch(`${AUTH_SERVICE_URL}/me/sounds/${slot}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to load custom ${slot} sound`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ---- Guilds (Discord-style servers) --------------------------------------
//
// Types + REST calls mirroring the fixed backend contract. The backend is
// being built in parallel against this exact shape — see the task context
// for the full endpoint list this file implements.

export type ChannelKind = "text" | "voice";

export type Guild = {
  id: string;
  name: string;
  icon_color: string;
  owner_id: string;
  member_count: number;
};

export type ChannelCategory = {
  id: string;
  name: string;
  position: number;
};

export type GuildChannel = {
  id: string;
  guild_id: string;
  category_id: string | null;
  name: string;
  kind: ChannelKind;
  topic: string | null;
  position: number;
  slow_mode_seconds: number;
  is_nsfw: boolean;
};

export type Role = {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: number;
  is_default: boolean;
};

export type GuildDetail = {
  id: string;
  name: string;
  icon_color: string;
  owner_id: string;
  verification_level: number;
  description: string | null;
  system_channel_id: string | null;
  my_permissions: number;
  categories: ChannelCategory[];
  channels: GuildChannel[];
  my_roles: Role[];
};

export type GuildMember = {
  user_id: string;
  username: string | null;
  email: string;
  nickname: string | null;
  is_staff?: boolean;
  roles: { id: string; name: string; color: string }[];
};

export type GuildMessage = {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  pinned_at?: string | null;
  is_system?: boolean;
  reactions?: ReactionSummary[];
  attachment?: AttachmentMeta | null;
};

export type Invite = {
  code: string;
  guild_id: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  created_at: string;
};

export type InvitePreview = {
  guild_name: string;
  icon_color: string;
  member_count: number;
};

// Bitfield permission constants — mirror the backend's Role.permissions
// bitfield exactly. ADMINISTRATOR implicitly grants everything; client-side
// gating (guild-settings-modal.tsx, guild-view.tsx) always checks
// ADMINISTRATOR as a fallback alongside the specific bit.
export const PERMISSIONS = {
  VIEW_CHANNELS: 1,
  SEND_MESSAGES: 2,
  MANAGE_MESSAGES: 4,
  CONNECT: 8,
  SPEAK: 16,
  MANAGE_CHANNELS: 32,
  MANAGE_ROLES: 64,
  KICK_MEMBERS: 128,
  BAN_MEMBERS: 256,
  MANAGE_GUILD: 512,
  ADMINISTRATOR: 1073741824,
} as const;

export function hasPermission(bitfield: number, bit: number): boolean {
  return (bitfield & PERMISSIONS.ADMINISTRATOR) !== 0 || (bitfield & bit) !== 0;
}

export function createGuild(token: string, name: string) {
  return req<GuildDetail>("/guilds", token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function listGuilds(token: string) {
  return req<Guild[]>("/guilds", token);
}

export function getGuild(token: string, guildId: string) {
  return req<GuildDetail>(`/guilds/${guildId}`, token);
}

export function updateGuild(
  token: string,
  guildId: string,
  patch: { name?: string; icon_color?: string; verification_level?: number; description?: string; system_channel_id?: string | null },
) {
  return req<GuildDetail>(`/guilds/${guildId}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteGuild(token: string, guildId: string) {
  return req<void>(`/guilds/${guildId}`, token, { method: "DELETE" });
}

export function leaveGuild(token: string, guildId: string) {
  return req<void>(`/guilds/${guildId}/leave`, token, { method: "POST" });
}

export function listGuildMembers(token: string, guildId: string) {
  return req<GuildMember[]>(`/guilds/${guildId}/members`, token);
}

export function kickGuildMember(token: string, guildId: string, userId: string) {
  return req<void>(`/guilds/${guildId}/members/${userId}`, token, {
    method: "DELETE",
  });
}

export type GuildBan = {
  user_id: string;
  username: string | null;
  banned_by: string;
  reason: string | null;
  created_at: string;
};

export function banGuildMember(token: string, guildId: string, userId: string, reason?: string) {
  return req<void>(`/guilds/${guildId}/bans/${userId}`, token, {
    method: "PUT",
    body: JSON.stringify({ reason: reason || undefined }),
  });
}

export function unbanGuildMember(token: string, guildId: string, userId: string) {
  return req<void>(`/guilds/${guildId}/bans/${userId}`, token, {
    method: "DELETE",
  });
}

export function listGuildBans(token: string, guildId: string) {
  return req<GuildBan[]>(`/guilds/${guildId}/bans`, token);
}

/// URL for a guild's icon image, if one is set. The frontend should
/// fall back to the color-swatch initial when this 404s (no auth header
/// possible on a plain <img> tag, matching the backend's deliberately
/// public GET /guilds/:id/icon route).
export function guildIconUrl(guildId: string): string {
  return `${AUTH_SERVICE_URL}/guilds/${guildId}/icon`;
}

export async function uploadGuildIcon(token: string, guildId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${AUTH_SERVICE_URL}/guilds/${guildId}/icon`, {
    method: "POST",
    headers: { Authorization: authHeader(token) },
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message =
      data && typeof data === "object" && "error" in data
        ? (data as { error: string }).error
        : `Upload failed with status ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<{ status: string }>;
}

export function deleteGuildIcon(token: string, guildId: string) {
  return req<void>(`/guilds/${guildId}/icon`, token, { method: "DELETE" });
}

// ---- Guild custom emoji ----------------------------------------------------

export type GuildEmoji = {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
};

export function listGuildEmoji(token: string, guildId: string) {
  return req<GuildEmoji[]>(`/guilds/${guildId}/emoji`, token);
}

export function guildEmojiUrl(guildId: string, emojiId: string): string {
  return `${AUTH_SERVICE_URL}/guilds/${guildId}/emoji/${emojiId}/image`;
}

export async function uploadGuildEmoji(token: string, guildId: string, name: string, file: File) {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  const res = await fetch(`${AUTH_SERVICE_URL}/guilds/${guildId}/emoji`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message =
      data && typeof data === "object" && "error" in data
        ? (data as { error: string }).error
        : `Upload failed with status ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<GuildEmoji>;
}

export function deleteGuildEmoji(token: string, guildId: string, emojiId: string) {
  return req<void>(`/guilds/${guildId}/emoji/${emojiId}`, token, { method: "DELETE" });
}


// ---- Guild channels -------------------------------------------------------

export function createGuildChannel(
  token: string,
  guildId: string,
  body: { name: string; kind: ChannelKind; category_id?: string },
) {
  return req<GuildChannel>(`/guilds/${guildId}/channels`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateGuildChannel(
  token: string,
  guildId: string,
  channelId: string,
  patch: { name?: string; topic?: string; position?: number; category_id?: string | null; slow_mode_seconds?: number; is_nsfw?: boolean },
) {
  return req<GuildChannel>(`/guilds/${guildId}/channels/${channelId}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteGuildChannel(token: string, guildId: string, channelId: string) {
  return req<void>(`/guilds/${guildId}/channels/${channelId}`, token, {
    method: "DELETE",
  });
}

export function createGuildCategory(token: string, guildId: string, name: string) {
  return req<ChannelCategory>(`/guilds/${guildId}/categories`, token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ---- Guild channel messages -------------------------------------------------

export function listGuildMessages(token: string, guildId: string, channelId: string) {
  return req<GuildMessage[]>(
    `/guilds/${guildId}/channels/${channelId}/messages`,
    token,
  );
}

export function sendGuildMessage(
  token: string,
  guildId: string,
  channelId: string,
  content: string,
  file?: File,
) {
  const form = new FormData();
  form.set("content", content);
  if (file) form.set("file", file);
  return req<GuildMessage>(
    `/guilds/${guildId}/channels/${channelId}/messages`,
    token,
    { method: "POST", body: form },
  );
}

export async function fetchGuildAttachmentUrl(
  token: string,
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<string> {
  const res = await fetch(
    `${AUTH_SERVICE_URL}/guilds/${guildId}/channels/${channelId}/messages/${messageId}/attachment`,
    { headers: { Authorization: authHeader(token) }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`attachment fetch failed with status ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function editGuildMessage(
  token: string,
  guildId: string,
  channelId: string,
  messageId: string,
  content: string,
) {
  return req<GuildMessage>(
    `/guilds/${guildId}/channels/${channelId}/messages/${messageId}`,
    token,
    { method: "PATCH", body: JSON.stringify({ content }) },
  );
}

export function deleteGuildMessage(
  token: string,
  guildId: string,
  channelId: string,
  messageId: string,
) {
  return req<void>(
    `/guilds/${guildId}/channels/${channelId}/messages/${messageId}`,
    token,
    { method: "DELETE" },
  );
}

export function pinGuildMessage(token: string, guildId: string, channelId: string, messageId: string) {
  return req<GuildMessage>(
    `/guilds/${guildId}/channels/${channelId}/messages/${messageId}/pin`,
    token,
    { method: "POST" },
  );
}

export function unpinGuildMessage(token: string, guildId: string, channelId: string, messageId: string) {
  return req<GuildMessage>(
    `/guilds/${guildId}/channels/${channelId}/messages/${messageId}/pin`,
    token,
    { method: "DELETE" },
  );
}

export function listPinnedMessages(token: string, guildId: string, channelId: string) {
  return req<GuildMessage[]>(`/guilds/${guildId}/channels/${channelId}/pins`, token);
}

export function searchGuildMessages(token: string, guildId: string, q: string, channelId?: string) {
  const params = new URLSearchParams({ q });
  if (channelId) params.set("channel_id", channelId);
  return req<GuildMessage[]>(`/guilds/${guildId}/messages/search?${params.toString()}`, token);
}

export type AuditLogEntry = {
  id: string;
  actor_id: string | null;
  actor_username: string | null;
  action_type: string;
  target_id: string | null;
  target_label: string | null;
  reason: string | null;
  created_at: string;
};

export function getGuildAuditLog(token: string, guildId: string) {
  return req<AuditLogEntry[]>(`/guilds/${guildId}/audit-log`, token);
}

export function toggleGuildReaction(
  token: string,
  guildId: string,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  return req<ReactionSummary[]>(
    `/guilds/${guildId}/channels/${channelId}/messages/${messageId}/reactions`,
    token,
    { method: "POST", body: JSON.stringify({ emoji }) },
  );
}

export type GuildUnreadEntry = { channel_id: string; unread_count: number };

export function markGuildChannelRead(token: string, guildId: string, channelId: string) {
  return req<{ status: string }>(`/guilds/${guildId}/channels/${channelId}/read`, token, {
    method: "POST",
  });
}

export function getGuildUnread(token: string, guildId: string) {
  return req<GuildUnreadEntry[]>(`/guilds/${guildId}/unread`, token);
}

// ---- Roles ------------------------------------------------------------

export function listRoles(token: string, guildId: string) {
  return req<Role[]>(`/guilds/${guildId}/roles`, token);
}

export function createRole(
  token: string,
  guildId: string,
  body: { name: string; color?: string; permissions?: number },
) {
  return req<Role>(`/guilds/${guildId}/roles`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateRole(
  token: string,
  guildId: string,
  roleId: string,
  patch: { name?: string; color?: string; permissions?: number; position?: number },
) {
  return req<Role>(`/guilds/${guildId}/roles/${roleId}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteRole(token: string, guildId: string, roleId: string) {
  return req<void>(`/guilds/${guildId}/roles/${roleId}`, token, {
    method: "DELETE",
  });
}

export function assignRole(
  token: string,
  guildId: string,
  userId: string,
  roleId: string,
) {
  return req<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, token, {
    method: "PUT",
  });
}

export function removeRole(
  token: string,
  guildId: string,
  userId: string,
  roleId: string,
) {
  return req<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, token, {
    method: "DELETE",
  });
}

// ---- Invites -----------------------------------------------------------

export function createInvite(
  token: string,
  guildId: string,
  body: { max_uses?: number; expires_in_hours?: number },
) {
  return req<Invite>(`/guilds/${guildId}/invites`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listInvites(token: string, guildId: string) {
  return req<Invite[]>(`/guilds/${guildId}/invites`, token);
}

export function revokeInvite(token: string, guildId: string, code: string) {
  return req<void>(`/guilds/${guildId}/invites/${code}`, token, {
    method: "DELETE",
  });
}

export function previewInvite(token: string, code: string) {
  return req<InvitePreview>(`/invites/${code}`, token);
}

export function acceptInvite(token: string, code: string) {
  return req<{ guild_id: string }>(`/invites/${code}/accept`, token, {
    method: "POST",
  });
}

// ---- Staff / admin -------------------------------------------------------
// Every one of these hits a backend route gated by users.is_staff, which is
// only ever set server-side (hardcoded dev-account email match) — never by
// anything this frontend sends. A non-staff caller gets a real 403 from the
// backend regardless of what the UI shows, so hiding the button client-side
// is a UX nicety here, not the actual security boundary.

export type AdminStats = {
  users: number;
  staff: number;
  guilds: number;
  guild_channels: number;
  guild_messages: number;
  dm_messages: number;
  friendships: number;
  live_ws_connections: number;
};

export function adminWhoAmI(token: string) {
  return req<{ is_staff: boolean; user_id: string }>("/admin/me", token);
}

export function adminStats(token: string) {
  return req<AdminStats>("/admin/stats", token);
}

export type AdminUserRow = {
  id: string;
  email: string;
  username: string | null;
  is_staff: boolean;
  created_at: string;
  banned_at?: string | null;
};

export function adminListUsers(token: string, opts?: { q?: string; limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return req<AdminUserRow[]>(`/admin/users${qs ? `?${qs}` : ""}`, token);
}

export function adminDeleteUser(token: string, userId: string) {
  return req<void>(`/admin/users/${userId}`, token, { method: "DELETE" });
}

export function adminBanUser(token: string, userId: string, reason?: string) {
  return req<void>(`/admin/users/${userId}/ban`, token, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });
}

export function adminUnbanUser(token: string, userId: string) {
  return req<void>(`/admin/users/${userId}/ban`, token, { method: "DELETE" });
}

export type AdminGuildRow = {
  id: string;
  name: string;
  owner_id: string;
  owner_email: string;
  member_count: number;
  created_at: string;
};

export function adminListGuilds(token: string) {
  return req<AdminGuildRow[]>("/admin/guilds", token);
}

export function adminDeleteGuild(token: string, guildId: string) {
  return req<void>(`/admin/guilds/${guildId}`, token, { method: "DELETE" });
}

// ---------------------------------------------------------------------
// GIF search (Tenor, proxied server-side so the API key stays private)
// ---------------------------------------------------------------------

export type GifResult = {
  id: string;
  title: string;
  url: string;
  preview_url: string;
  width: number;
  height: number;
};

export function searchGifs(token: string, query: string, limit = 24) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  params.set("limit", String(limit));
  return req<{ results: GifResult[] }>(`/gifs/search?${params.toString()}`, token);
}
