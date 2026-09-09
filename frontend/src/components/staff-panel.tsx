"use client";

// Staff Panel — real admin surface, gated end-to-end. This component ONLY
// ever renders for a user whose /me response says is_staff: true, and
// every single API call it makes is independently re-checked by the
// backend against users.is_staff (see admin.rs's require_staff). Hiding
// this UI is a nicety, not the security boundary — a non-staff user
// hitting these endpoints directly gets a real 403 no matter what.
//
// Tabs: Overview (live server-wide stats), Users (search/list/delete),
// Servers (every guild on the instance, force-delete for moderation).

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  X,
  ShieldCheck,
  ShieldOff,
  ShieldBan,
  Users,
  Server,
  Activity,
  Trash2,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  adminStats,
  adminListUsers,
  adminDeleteUser,
  adminBanUser,
  adminUnbanUser,
  adminListGuilds,
  adminDeleteGuild,
  type AdminStats,
  type AdminUserRow,
  type AdminGuildRow,
} from "@/lib/backend-api";

type Tab = "overview" | "users" | "servers";

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-[#1D2129] bg-[#12151B] px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">{label}</p>
      <p className="mt-1 font-display text-2xl italic text-[#E8EAED]">{value}</p>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.max(0, Math.floor(ms / 60_000));
  return `${mins}m ago`;
}

export function StaffPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { getToken } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<AdminStats | null>(null);

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [usersLoading, setUsersLoading] = useState(false);
  const [pendingDeleteUser, setPendingDeleteUser] = useState<AdminUserRow | null>(null);

  const [guilds, setGuilds] = useState<AdminGuildRow[]>([]);
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [pendingDeleteGuild, setPendingDeleteGuild] = useState<AdminGuildRow | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const loadOverview = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      setStats(await adminStats(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stats");
    }
  }, [getToken]);

  const loadUsers = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setUsersLoading(true);
    try {
      setUsers(await adminListUsers(token, { q: userQuery || undefined, limit: 100 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setUsersLoading(false);
    }
  }, [getToken, userQuery]);

  const loadGuilds = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setGuildsLoading(true);
    try {
      setGuilds(await adminListGuilds(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load servers");
    } finally {
      setGuildsLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (tab === "overview") void loadOverview();
    else if (tab === "users") void loadUsers();
    else if (tab === "servers") void loadGuilds();
  }, [open, tab, loadOverview, loadUsers, loadGuilds]);

  async function handleDeleteUser() {
    if (!pendingDeleteUser) return;
    const token = await getToken();
    if (!token) return;
    try {
      await adminDeleteUser(token, pendingDeleteUser.id);
      setPendingDeleteUser(null);
      await loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete user");
    }
  }

  async function handleToggleBan(u: AdminUserRow) {
    const token = await getToken();
    if (!token) return;
    try {
      if (u.banned_at) {
        await adminUnbanUser(token, u.id);
      } else {
        await adminBanUser(token, u.id, "Banned via staff panel");
      }
      await loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update ban status");
    }
  }

  async function handleDeleteGuild() {
    if (!pendingDeleteGuild) return;
    const token = await getToken();
    if (!token) return;
    try {
      await adminDeleteGuild(token, pendingDeleteGuild.id);
      setPendingDeleteGuild(null);
      await loadGuilds();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete server");
    }
  }

  if (!open) return null;

  const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
    { id: "overview", label: "Overview", icon: Activity },
    { id: "users", label: "Users", icon: Users },
    { id: "servers", label: "Servers", icon: Server },
  ];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-2 backdrop-blur-[2px] sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain noschat-app animate-rise-in relative flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#F0A868]/20 bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.15),0_24px_60px_-20px_rgba(0,0,0,0.85)] sm:h-[85vh]"
      >
        <div className="flex flex-none items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="size-5 text-[#F0A868]" />
            <h2 className="font-display text-2xl italic text-[#E8EAED]">Staff Panel</h2>
          </div>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-44 flex-none flex-col gap-1 border-r border-white/[0.06] p-3">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                data-active={tab === t.id}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1E232C] data-[active=true]:text-[#F0A868]"
              >
                <t.icon className="size-4" /> {t.label}
              </button>
            ))}
          </div>

          <div className="noschat-scroll flex-1 overflow-y-auto p-5">
            {error && <p className="mb-4 text-xs text-[#EB5757]">{error}</p>}

            {tab === "overview" && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {!stats ? (
                  <p className="col-span-full text-sm text-[#8B93A1]">Loading…</p>
                ) : (
                  <>
                    <StatCard label="Users" value={stats.users} />
                    <StatCard label="Staff" value={stats.staff} />
                    <StatCard label="Servers" value={stats.guilds} />
                    <StatCard label="Server channels" value={stats.guild_channels} />
                    <StatCard label="Server messages" value={stats.guild_messages} />
                    <StatCard label="DM messages" value={stats.dm_messages} />
                    <StatCard label="Friendships" value={stats.friendships} />
                    <StatCard label="Live connections" value={stats.live_ws_connections} />
                  </>
                )}
              </div>
            )}

            {tab === "users" && (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#8B93A1]" />
                  <Input
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void loadUsers()}
                    placeholder="Search by email or username…"
                    className="h-10 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 pl-9 text-[#E8EAED]"
                  />
                </div>
                {usersLoading ? (
                  <p className="text-sm text-[#8B93A1]">Loading…</p>
                ) : (
                  <div className="space-y-1.5">
                    {users.map((u) => (
                      <div
                        key={u.id}
                        className="noschat-hover-lift flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-[#E8EAED]">
                            {u.username ?? u.email}
                            {u.is_staff && (
                              <span className="ml-2 rounded-full bg-[#F0A868]/15 px-2 py-0.5 text-[10px] text-[#F0A868]">
                                STAFF
                              </span>
                            )}
                            {u.banned_at && (
                              <span className="ml-2 rounded-full bg-[#EB5757]/15 px-2 py-0.5 text-[10px] text-[#EB5757]">
                                BANNED
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-[#8B93A1]">
                            {u.email} · joined {timeAgo(u.created_at)}
                          </p>
                        </div>
                        {!u.is_staff && (
                          <>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => void handleToggleBan(u)}
                              className={u.banned_at ? "hover:bg-[#4ADE80]/10" : "hover:bg-[#EB5757]/10"}
                              title={u.banned_at ? "Unban user" : "Ban user"}
                            >
                              {u.banned_at ? (
                                <ShieldOff className="size-3.5 text-[#4ADE80]" />
                              ) : (
                                <ShieldBan className="size-3.5 text-[#EB5757]" />
                              )}
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => setPendingDeleteUser(u)}
                              className="hover:bg-[#EB5757]/10"
                              title="Delete user"
                            >
                              <Trash2 className="size-3.5 text-[#EB5757]" />
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                    {users.length === 0 && (
                      <p className="text-sm text-[#8B93A1]">No users found.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "servers" && (
              <div className="space-y-1.5">
                {guildsLoading ? (
                  <p className="text-sm text-[#8B93A1]">Loading…</p>
                ) : (
                  <>
                    {guilds.map((g) => (
                      <div
                        key={g.id}
                        className="noschat-hover-lift flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-[#E8EAED]">{g.name}</p>
                          <p className="truncate text-xs text-[#8B93A1]">
                            owner {g.owner_email} · {g.member_count} member{g.member_count === 1 ? "" : "s"} ·
                            created {timeAgo(g.created_at)}
                          </p>
                        </div>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => setPendingDeleteGuild(g)}
                          className="hover:bg-[#EB5757]/10"
                          title="Delete server"
                        >
                          <Trash2 className="size-3.5 text-[#EB5757]" />
                        </Button>
                      </div>
                    ))}
                    {guilds.length === 0 && (
                      <p className="text-sm text-[#8B93A1]">No servers.</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingDeleteUser && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/75 p-4"
          onClick={() => setPendingDeleteUser(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <h3 className="mb-2 font-display text-xl italic text-[#E8EAED]">
              Delete {pendingDeleteUser.username ?? pendingDeleteUser.email}?
            </h3>
            <p className="mb-4 text-sm text-[#8B93A1]">
              Removes this user's NosChat data (not their Clerk login — they'd get a fresh account on next sign-in). This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPendingDeleteUser(null)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDeleteUser}>Delete User</Button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteGuild && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/75 p-4"
          onClick={() => setPendingDeleteGuild(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="noschat-grain animate-rise-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
          >
            <h3 className="mb-2 font-display text-xl italic text-[#E8EAED]">
              Force-delete {pendingDeleteGuild.name}?
            </h3>
            <p className="mb-4 text-sm text-[#8B93A1]">
              Deletes this server for every member, regardless of ownership. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPendingDeleteGuild(null)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDeleteGuild}>Delete Server</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
