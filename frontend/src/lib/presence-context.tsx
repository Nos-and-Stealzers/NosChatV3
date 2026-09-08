"use client";

// Discord-style presence layer: owns the current user's own profile (bio,
// pronouns, colors, status text, presence mode) plus a live map of
// friend-status updates streamed over the same websocket realtime-context.tsx
// already owns. Also exposes a small on-demand profile cache so any avatar
// anywhere (not just friends) can resolve a full profile for its hover/click
// card via the real `GET /users/:id` route, which is open to any signed-in
// user per profiles.rs.
//
// Real data only: statuses come from the backend's actual live-WebSocket
// derived `effective_status` (see profiles.rs), not decoration. "invisible"
// never appears here — the backend already collapses it to "offline" for
// everyone but the owner.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "@clerk/nextjs";
import {
  getOwnProfile,
  getPublicProfile,
  setPresenceMode as apiSetPresenceMode,
  updateProfile as apiUpdateProfile,
  type OwnProfile,
  type PresenceMode,
  type PresenceStatus,
  type PublicProfile,
} from "@/lib/backend-api";
import { useRealtime } from "@/lib/realtime-context";

type PresenceContextValue = {
  ownProfile: OwnProfile | null;
  ownProfileLoading: boolean;
  refreshOwnProfile: () => Promise<void>;
  updateOwnProfile: (patch: {
    bio?: string;
    pronouns?: string;
    accent_color?: string;
    banner_color?: string;
    status_text?: string;
  }) => Promise<void>;
  setPresenceMode: (mode: PresenceMode) => Promise<void>;
  // Real-time friend status map, keyed by user id. Only ever populated by
  // actual `presence_update` websocket events — never guessed client-side.
  statuses: Record<string, { status: PresenceStatus; status_text: string | null }>;
  // Resolves a status for any user id: own id -> ownProfile.status, known
  // friend -> live map, unknown -> "offline" (never fabricated as "online").
  statusOf: (userId: string | null | undefined) => PresenceStatus;
  // On-demand profile fetch + cache, for clicking any avatar (friend, DM
  // partner, guild member) to view their real profile card.
  fetchProfile: (userId: string) => Promise<PublicProfile | null>;
  profileCache: Record<string, PublicProfile>;
};

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { getToken } = useAuth();
  const { subscribe } = useRealtime();
  const [ownProfile, setOwnProfile] = useState<OwnProfile | null>(null);
  const [ownProfileLoading, setOwnProfileLoading] = useState(true);
  const [statuses, setStatuses] = useState<
    Record<string, { status: PresenceStatus; status_text: string | null }>
  >({});
  const [profileCache, setProfileCache] = useState<Record<string, PublicProfile>>({});
  const profileCacheRef = useRef(profileCache);
  useEffect(() => {
    profileCacheRef.current = profileCache;
  }, [profileCache]);
  const inFlight = useRef<Set<string>>(new Set());

  const refreshOwnProfile = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const p = await getOwnProfile(token);
      setOwnProfile(p);
    } catch {
      // no local user row yet / backend not synced — leave null, UI treats
      // that as "profile unavailable" rather than fabricating one.
    } finally {
      setOwnProfileLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void refreshOwnProfile();
  }, [refreshOwnProfile]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "presence_update") {
        setStatuses((prev) => ({
          ...prev,
          [event.user_id]: { status: event.status, status_text: event.status_text },
        }));
        // Keep any cached profile card in sync too, so a card left open
        // reflects the live status/status_text without a manual refetch.
        setProfileCache((prev) => {
          const existing = prev[event.user_id];
          if (!existing) return prev;
          return {
            ...prev,
            [event.user_id]: {
              ...existing,
              status: event.status,
              status_text: event.status_text,
            },
          };
        });
      }
    });
  }, [subscribe]);

  const updateOwnProfile = useCallback(
    async (patch: {
      bio?: string;
      pronouns?: string;
      accent_color?: string;
      banner_color?: string;
      status_text?: string;
    }) => {
      const token = await getToken();
      if (!token) return;
      const updated = await apiUpdateProfile(token, patch);
      setOwnProfile(updated);
    },
    [getToken],
  );

  const setPresenceMode = useCallback(
    async (mode: PresenceMode) => {
      const token = await getToken();
      if (!token) return;
      const res = await apiSetPresenceMode(token, mode);
      setOwnProfile((prev) =>
        prev ? { ...prev, presence_mode: res.presence_mode, status: res.status } : prev,
      );
    },
    [getToken],
  );

  // Stable identity across cache updates (deps intentionally exclude
  // profileCache — it reads via profileCacheRef instead) so components that
  // fetch a batch of profiles in a mount effect (e.g. guild-view.tsx's
  // member-list presence seed) don't re-run that effect on every single
  // profile that lands, which would otherwise refire it in a loop.
  const fetchProfile = useCallback(
    async (userId: string): Promise<PublicProfile | null> => {
      if (profileCacheRef.current[userId]) return profileCacheRef.current[userId];
      if (inFlight.current.has(userId)) return null;
      inFlight.current.add(userId);
      try {
        const token = await getToken();
        if (!token) return null;
        const p = await getPublicProfile(token, userId);
        setProfileCache((prev) => ({ ...prev, [userId]: p }));
        return p;
      } catch {
        return null;
      } finally {
        inFlight.current.delete(userId);
      }
    },
    [getToken],
  );

  const statusOf = useCallback(
    (userId: string | null | undefined): PresenceStatus => {
      if (!userId) return "offline";
      if (ownProfile && userId === ownProfile.id) return ownProfile.status;
      return statuses[userId]?.status ?? profileCache[userId]?.status ?? "offline";
    },
    [ownProfile, statuses, profileCache],
  );

  return (
    <PresenceContext.Provider
      value={{
        ownProfile,
        ownProfileLoading,
        refreshOwnProfile,
        updateOwnProfile,
        setPresenceMode,
        statuses,
        statusOf,
        fetchProfile,
        profileCache,
      }}
    >
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence() {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error("usePresence must be used within PresenceProvider");
  return ctx;
}
