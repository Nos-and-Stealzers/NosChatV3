"use client";

// Guild settings modal — General / Roles / Members / Invites tabs, gated by
// the current user's permission bitfield (my_permissions on GuildDetail).
// Chrome matches settings-panel.tsx (rise-in, backdrop, Escape-to-close).

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  X,
  Trash2,
  Plus,
  ArrowUp,
  ArrowDown,
  Copy,
  Check,
  Ban as BanIcon,
  Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClickableAvatar } from "@/components/profile-card";
import { Input } from "@/components/ui/input";
import {
  getGuild,
  updateGuild,
  listGuildMembers,
  kickGuildMember,
  banGuildMember,
  unbanGuildMember,
  listGuildBans,
  getGuildAuditLog,
  type AuditLogEntry,
  uploadGuildIcon,
  deleteGuildIcon,
  guildIconUrl,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  assignRole,
  removeRole,
  listInvites,
  createInvite,
  revokeInvite,
  hasPermission,
  PERMISSIONS,
  type GuildDetail,
  type GuildMember,
  type GuildBan,
  type Role,
  type Invite,
} from "@/lib/backend-api";

type Tab = "general" | "roles" | "members" | "bans" | "invites" | "audit-log";

const ICON_COLORS = [
  "#F0A868", "#5FD9C4", "#8FA6F0", "#E88FD0", "#F0C868", "#7ED0E8", "#EB5757", "#4ADE80",
];

const PERMISSION_GROUPS: { title: string; perms: { bit: number; label: string }[] }[] = [
  {
    title: "General",
    perms: [
      { bit: PERMISSIONS.ADMINISTRATOR, label: "Administrator (all permissions)" },
      { bit: PERMISSIONS.MANAGE_GUILD, label: "Manage Server" },
      { bit: PERMISSIONS.MANAGE_ROLES, label: "Manage Roles" },
      { bit: PERMISSIONS.MANAGE_CHANNELS, label: "Manage Channels" },
    ],
  },
  {
    title: "Membership",
    perms: [
      { bit: PERMISSIONS.KICK_MEMBERS, label: "Kick Members" },
      { bit: PERMISSIONS.BAN_MEMBERS, label: "Ban Members" },
    ],
  },
  {
    title: "Text Channels",
    perms: [
      { bit: PERMISSIONS.VIEW_CHANNELS, label: "View Channels" },
      { bit: PERMISSIONS.SEND_MESSAGES, label: "Send Messages" },
      { bit: PERMISSIONS.MANAGE_MESSAGES, label: "Manage Messages" },
    ],
  },
  {
    title: "Voice Channels",
    perms: [
      { bit: PERMISSIONS.CONNECT, label: "Connect" },
      { bit: PERMISSIONS.SPEAK, label: "Speak" },
    ],
  },
];

export function GuildSettingsModal({
  open,
  onClose,
  guildId,
  initialTab,
  onGuildUpdated,
}: {
  open: boolean;
  onClose: () => void;
  guildId: string;
  initialTab?: Tab;
  onGuildUpdated?: () => void;
}) {
  const { getToken } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const [detail, setDetail] = useState<GuildDetail | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [colorDraft, setColorDraft] = useState("#F0A868");
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [iconImgKey, setIconImgKey] = useState(0);
  const [iconHasImage, setIconHasImage] = useState(true);

  const [members, setMembers] = useState<GuildMember[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [bans, setBans] = useState<GuildBan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [newInviteMaxUses, setNewInviteMaxUses] = useState("");
  const [newInviteExpiry, setNewInviteExpiry] = useState("");
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [verificationLevelDraft, setVerificationLevelDraft] = useState(0);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const refresh = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const d = await getGuild(token, guildId);
      setDetail(d);
      setNameDraft(d.name);
      setColorDraft(d.icon_color);
      setVerificationLevelDraft(d.verification_level);
      if (hasPermission(d.my_permissions, PERMISSIONS.MANAGE_ROLES)) {
        setRoles(await listRoles(token, guildId));
      }
      setMembers(await listGuildMembers(token, guildId));
      if (hasPermission(d.my_permissions, PERMISSIONS.BAN_MEMBERS)) {
        setBans(await listGuildBans(token, guildId));
      }
      if (hasPermission(d.my_permissions, PERMISSIONS.ADMINISTRATOR)) {
        setAuditLog(await getGuildAuditLog(token, guildId));
      }
      if (hasPermission(d.my_permissions, PERMISSIONS.MANAGE_GUILD)) {
        setInvites(await listInvites(token, guildId));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load server settings");
    }
  }, [getToken, guildId]);

  useEffect(() => {
    if (open) {
      setTab(initialTab ?? "general");
      setError(null);
      void refresh();
    }
  }, [open, initialTab, refresh]);

  if (!open) return null;

  const myPerms = detail?.my_permissions ?? 0;
  const canManageGuild = hasPermission(myPerms, PERMISSIONS.MANAGE_GUILD);
  const canManageRoles = hasPermission(myPerms, PERMISSIONS.MANAGE_ROLES);
  const canKick = hasPermission(myPerms, PERMISSIONS.KICK_MEMBERS);
  const canBan = hasPermission(myPerms, PERMISSIONS.BAN_MEMBERS);
  const canAdmin = hasPermission(myPerms, PERMISSIONS.ADMINISTRATOR);

  const tabs: { id: Tab; label: string; visible: boolean }[] = [
    { id: "general" as Tab, label: "General", visible: canManageGuild },
    { id: "roles" as Tab, label: "Roles", visible: canManageRoles },
    { id: "members" as Tab, label: "Members", visible: true },
    { id: "bans" as Tab, label: "Bans", visible: canBan },
    { id: "invites" as Tab, label: "Invites", visible: canManageGuild },
    { id: "audit-log" as Tab, label: "Audit Log", visible: canAdmin },
  ].filter((t) => t.visible);

  async function handleSaveGeneral() {
    setSavingGeneral(true);
    try {
      const token = await getToken();
      if (!token) return;
      await updateGuild(token, guildId, { name: nameDraft.trim(), icon_color: colorDraft, verification_level: verificationLevelDraft });
      await refresh();
      onGuildUpdated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update server");
    } finally {
      setSavingGeneral(false);
    }
  }

  async function handleIconFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingIcon(true);
    try {
      const token = await getToken();
      if (!token) return;
      await uploadGuildIcon(token, guildId, file);
      setIconHasImage(true);
      setIconImgKey((k) => k + 1);
      onGuildUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload icon");
    } finally {
      setUploadingIcon(false);
    }
  }

  async function handleRemoveIconImage() {
    setUploadingIcon(true);
    try {
      const token = await getToken();
      if (!token) return;
      await deleteGuildIcon(token, guildId);
      setIconHasImage(false);
      onGuildUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove icon");
    } finally {
      setUploadingIcon(false);
    }
  }

  async function handleCreateRole() {
    const token = await getToken();
    if (!token) return;
    try {
      await createRole(token, guildId, { name: "New Role", color: "#8B93A1", permissions: 0 });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create role");
    }
  }

  async function handleTogglePermission(role: Role, bit: number) {
    const token = await getToken();
    if (!token) return;
    const nextPerms = (role.permissions & bit) !== 0 ? role.permissions & ~bit : role.permissions | bit;
    try {
      await updateRole(token, guildId, role.id, { permissions: nextPerms });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
    }
  }

  async function handleRenameRole(role: Role, name: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await updateRole(token, guildId, role.id, { name });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename role");
    }
  }

  async function handleMoveRole(role: Role, direction: "up" | "down") {
    const token = await getToken();
    if (!token) return;
    const delta = direction === "up" ? 1 : -1;
    try {
      await updateRole(token, guildId, role.id, { position: role.position + delta });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reorder role");
    }
  }

  async function handleDeleteRole(roleId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await deleteRole(token, guildId, roleId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete role");
    }
  }

  async function handleKick(userId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await kickGuildMember(token, guildId, userId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to kick member");
    }
  }

  async function handleBan(userId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await banGuildMember(token, guildId, userId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to ban member");
    }
  }

  async function handleUnban(userId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await unbanGuildMember(token, guildId, userId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unban member");
    }
  }

  async function handleAssignRole(userId: string, roleId: string) {
    const token = await getToken();
    if (!token || !roleId) return;
    try {
      await assignRole(token, guildId, userId, roleId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign role");
    }
  }

  async function handleRemoveRole(userId: string, roleId: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await removeRole(token, guildId, userId, roleId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove role");
    }
  }

  async function handleCreateInvite() {
    const token = await getToken();
    if (!token) return;
    try {
      await createInvite(token, guildId, {
        max_uses: newInviteMaxUses ? Number(newInviteMaxUses) : undefined,
        expires_in_hours: newInviteExpiry ? Number(newInviteExpiry) : undefined,
      });
      setNewInviteMaxUses("");
      setNewInviteExpiry("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create invite");
    }
  }

  async function handleRevokeInvite(code: string) {
    const token = await getToken();
    if (!token) return;
    try {
      await revokeInvite(token, guildId, code);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke invite");
    }
  }

  function handleCopyInvite(code: string) {
    const url = `${window.location.origin}/invite/${code}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1500);
    });
  }

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-2 backdrop-blur-[2px] sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain noschat-app animate-rise-in relative flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75)] sm:h-[80vh]"
      >
        <div className="flex flex-none items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="font-display text-2xl italic text-[#E8EAED]">
            {detail?.name ?? "Server"} Settings
          </h2>
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
                className="rounded-lg px-3 py-2 text-left text-sm text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1E232C] data-[active=true]:text-[#F0A868]"
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="noschat-scroll flex-1 overflow-y-auto p-5">
            {error && <p className="mb-4 text-xs text-[#EB5757]">{error}</p>}

            {tab === "general" && canManageGuild && (
              <div className="max-w-md space-y-5">
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Server Name
                  </label>
                  <Input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    className="h-10 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-[#E8EAED]"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Server Icon
                  </label>
                  <div className="flex items-center gap-3">
                    <div
                      className="relative flex size-14 flex-none items-center justify-center overflow-hidden rounded-full font-display text-xl text-[#12151A]"
                      style={{ backgroundColor: colorDraft }}
                    >
                      {iconHasImage && (
                        // eslint-disable-next-line @next/next/no-img-element -- backend-hosted image
                        <img
                          key={iconImgKey}
                          src={`${guildIconUrl(guildId)}?v=${iconImgKey}`}
                          alt=""
                          onError={() => setIconHasImage(false)}
                          className="absolute inset-0 size-full object-cover"
                        />
                      )}
                      {!iconHasImage && (detail?.name.trim()[0] ?? "?").toUpperCase()}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleIconFileChange}
                          disabled={uploadingIcon}
                          className="hidden"
                        />
                        <span className="inline-flex h-8 items-center rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 px-3 text-xs font-medium text-[#E8EAED] transition-colors hover:border-[#3A4050]">
                          {uploadingIcon ? "Uploading…" : "Upload Image"}
                        </span>
                      </label>
                      {iconHasImage && (
                        <button
                          onClick={handleRemoveIconImage}
                          disabled={uploadingIcon}
                          className="text-left text-xs text-[#8B93A1] hover:text-[#EB5757]"
                        >
                          Remove image
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Icon Color
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {ICON_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setColorDraft(c)}
                        className="size-8 rounded-full ring-offset-2 ring-offset-[#1E232C] transition-all"
                        style={{
                          backgroundColor: c,
                          boxShadow: colorDraft === c ? `0 0 0 2px #12151A, 0 0 0 4px ${c}` : undefined,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                    Verification Level
                  </label>
                  <p className="mb-2 text-xs text-[#8B93A1]">
                    Controls who can send messages in this server.
                  </p>
                  <div className="flex gap-2">
                    {[
                      { value: 0, label: "None", desc: "Unrestricted" },
                      { value: 1, label: "Low", desc: "Account must be 10+ min old" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setVerificationLevelDraft(opt.value)}
                        className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                          verificationLevelDraft === opt.value
                            ? "border-[#F0A868] bg-[#F0A868]/10"
                            : "border-[#2A2F3A] bg-[#0F1217]/80 hover:border-[#3A4050]"
                        }`}
                      >
                        <p className="text-sm font-medium text-[#E8EAED]">{opt.label}</p>
                        <p className="text-[11px] text-[#8B93A1]">{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <Button onClick={handleSaveGeneral} disabled={savingGeneral || !nameDraft.trim()}>
                  {savingGeneral ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            )}

            {tab === "roles" && canManageRoles && (
              <div className="space-y-4">
                <Button size="sm" variant="secondary" onClick={handleCreateRole}>
                  <Plus className="size-3.5" /> New Role
                </Button>
                <div className="space-y-3">
                  {[...roles].sort((a, b) => b.position - a.position).map((role) => (
                    <div key={role.id} className="rounded-xl border border-[#1D2129] bg-[#12151B] p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span
                          className="size-3 flex-none rounded-full"
                          style={{ backgroundColor: role.color || "#8B93A1" }}
                        />
                        <Input
                          value={role.name}
                          onChange={(e) => handleRenameRole(role, e.target.value)}
                          disabled={role.is_default}
                          className="h-8 flex-1 rounded-md border-[#2A2F3A] bg-[#0F1217]/80 text-sm text-[#E8EAED]"
                        />
                        <Button size="icon-sm" variant="ghost" onClick={() => handleMoveRole(role, "up")}>
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => handleMoveRole(role, "down")}>
                          <ArrowDown className="size-3.5" />
                        </Button>
                        {!role.is_default && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => handleDeleteRole(role.id)}
                            className="hover:bg-[#EB5757]/10"
                          >
                            <Trash2 className="size-3.5 text-[#EB5757]" />
                          </Button>
                        )}
                      </div>
                      <div className="space-y-3">
                        {PERMISSION_GROUPS.map((group) => (
                          <div key={group.title}>
                            <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.15em] text-[#8B93A1]/70">
                              {group.title}
                            </p>
                            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                              {group.perms.map(({ bit, label }) => (
                                <label
                                  key={bit}
                                  className="flex items-center gap-1.5 text-xs text-[#C7CDD6]"
                                >
                                  <input
                                    type="checkbox"
                                    checked={(role.permissions & bit) !== 0}
                                    onChange={() => handleTogglePermission(role, bit)}
                                    disabled={
                                      bit !== PERMISSIONS.ADMINISTRATOR &&
                                      (role.permissions & PERMISSIONS.ADMINISTRATOR) !== 0
                                    }
                                    className="size-3.5 accent-[#F0A868] disabled:opacity-40"
                                  />
                                  {label}
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "members" && (
              <div className="space-y-2">
                {members.map((m) => {
                  const label = m.nickname ?? m.username ?? m.email;
                  return (
                    <div
                      key={m.user_id}
                      className="flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-[#E8EAED]">
                        <ClickableAvatar userId={m.user_id} label={label} size="sm" />
                        {m.user_id === detail?.owner_id && (
                          <span title="Server Owner">
                            <Crown className="size-3.5 flex-none text-[#F0C868]" />
                          </span>
                        )}
                        <span className="truncate">{label}</span>
                        {m.is_staff && (
                          <span
                            title="NosChat Staff"
                            className="flex-none rounded-full bg-[#5FD9C4]/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-[#5FD9C4]"
                          >
                            STAFF
                          </span>
                        )}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {m.roles.map((r) => (
                          <span
                            key={r.id}
                            className="rounded-full px-2 py-0.5 text-[10px]"
                            style={{ backgroundColor: `${r.color}22`, color: r.color }}
                          >
                            {r.name}
                            {canManageRoles && (
                              <button
                                onClick={() => handleRemoveRole(m.user_id, r.id)}
                                className="ml-1 opacity-60 hover:opacity-100"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                      {canManageRoles && roles.length > 0 && (
                        <select
                          onChange={(e) => {
                            if (e.target.value) handleAssignRole(m.user_id, e.target.value);
                            e.target.value = "";
                          }}
                          defaultValue=""
                          className="rounded-md border border-[#2A2F3A] bg-[#0F1217]/80 px-2 py-1 text-xs text-[#E8EAED]"
                        >
                          <option value="" disabled>
                            + Role
                          </option>
                          {roles
                            .filter((r) => !m.roles.some((mr) => mr.id === r.id))
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                        </select>
                      )}
                      {canKick && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => handleKick(m.user_id)}
                          className="hover:bg-[#EB5757]/10"
                          title="Kick"
                        >
                          <Trash2 className="size-3.5 text-[#EB5757]" />
                        </Button>
                      )}
                      {canBan && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => handleBan(m.user_id)}
                          className="hover:bg-[#EB5757]/10"
                          title="Ban"
                        >
                          <BanIcon className="size-3.5 text-[#EB5757]" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === "bans" && canBan && (
              <div className="space-y-2">
                {bans.length === 0 && (
                  <p className="text-sm text-[#8B93A1]">No banned users.</p>
                )}
                {bans.map((b) => (
                  <div
                    key={b.user_id}
                    className="flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5"
                  >
                    <BanIcon className="size-3.5 flex-none text-[#EB5757]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[#E8EAED]">
                        {b.username ?? b.user_id}
                      </p>
                      {b.reason && (
                        <p className="truncate text-xs text-[#8B93A1]">{b.reason}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleUnban(b.user_id)}
                    >
                      Unban
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {tab === "audit-log" && canAdmin && (
              <div className="space-y-1.5">
                {auditLog.length === 0 && (
                  <p className="text-sm text-[#8B93A1]">No moderation activity yet.</p>
                )}
                {auditLog.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5 text-sm"
                  >
                    <p className="text-[#E8EAED]">
                      <span className="font-medium">{entry.actor_username ?? "Unknown"}</span>{" "}
                      <span className="text-[#8B93A1]">
                        {{
                          member_kick: "kicked",
                          member_ban: "banned",
                          member_unban: "unbanned",
                          channel_delete: "deleted channel",
                        }[entry.action_type] ?? entry.action_type}
                      </span>{" "}
                      {entry.target_label && (
                        <span className="font-medium">{entry.target_label}</span>
                      )}
                    </p>
                    {entry.reason && (
                      <p className="mt-0.5 truncate text-xs text-[#8B93A1]">
                        Reason: {entry.reason}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-[#5A6272]">
                      {new Date(entry.created_at).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {tab === "invites" && canManageGuild && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                      Max Uses
                    </label>
                    <Input
                      type="number"
                      value={newInviteMaxUses}
                      onChange={(e) => setNewInviteMaxUses(e.target.value)}
                      placeholder="∞"
                      className="h-9 w-28 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-sm text-[#E8EAED]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                      Expires (hrs)
                    </label>
                    <Input
                      type="number"
                      value={newInviteExpiry}
                      onChange={(e) => setNewInviteExpiry(e.target.value)}
                      placeholder="never"
                      className="h-9 w-28 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-sm text-[#E8EAED]"
                    />
                  </div>
                  <Button size="sm" onClick={handleCreateInvite}>
                    <Plus className="size-3.5" /> Create Invite
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {invites.map((inv) => (
                    <div
                      key={inv.code}
                      className="flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-2.5"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-[#E8EAED]">
                        /invite/{inv.code}
                      </span>
                      <span className="flex-none text-xs text-[#8B93A1]">
                        {inv.uses}/{inv.max_uses ?? "∞"} uses
                      </span>
                      <span className="ml-auto flex items-center gap-1">
                        <Button size="icon-sm" variant="ghost" onClick={() => handleCopyInvite(inv.code)}>
                          {copiedCode === inv.code ? (
                            <Check className="size-3.5 text-[#4ADE80]" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => handleRevokeInvite(inv.code)}
                          className="hover:bg-[#EB5757]/10"
                        >
                          <Trash2 className="size-3.5 text-[#EB5757]" />
                        </Button>
                      </span>
                    </div>
                  ))}
                  {invites.length === 0 && (
                    <p className="text-sm text-[#8B93A1]">No active invites.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
