const AUTH_SERVICE_URL =
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? "http://localhost:4000";

export const WS_URL =
  process.env.NEXT_PUBLIC_AUTH_SERVICE_WS_URL ?? "ws://localhost:4000/ws";

export type BackendUser = {
  id: string;
  clerk_user_id: string;
  email: string;
  username: string | null;
};

async function req<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${AUTH_SERVICE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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

export type DmSummary = {
  id: string;
  other_user_id: string | null;
  other_username: string | null;
  other_email: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
};

export type Message = {
  id: string;
  dm_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
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

export function listMessages(token: string, dmId: string) {
  return req<Message[]>(`/dms/${dmId}/messages`, token);
}

export function sendMessage(token: string, dmId: string, content: string) {
  return req<Message>(`/dms/${dmId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
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
