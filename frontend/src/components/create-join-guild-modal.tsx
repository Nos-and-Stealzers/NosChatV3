"use client";

// "Create or Join a Server" modal — two tabs, matching settings-panel.tsx's
// modal chrome (rise-in, backdrop-click-to-close, Escape-to-close).

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createGuild,
  previewInvite,
  acceptInvite,
  type GuildDetail,
  type InvitePreview,
} from "@/lib/backend-api";

type Tab = "create" | "join";

// Tolerates a pasted full invite URL (e.g.
// "https://noschat.example/invite/abc123") as well as a bare code —
// extracts just the trailing path segment either way. Shared by both
// the preview and join calls so a pasted URL works end-to-end, not just
// for the preview step.
function parseInviteCode(input: string): string {
  const raw = input.trim();
  return raw.includes("/") ? raw.split("/").filter(Boolean).pop()! : raw;
}

export function CreateJoinGuildModal({
  open,
  onClose,
  onCreated,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (guild: GuildDetail) => void;
  onJoined: (guildId: string) => void;
}) {
  const { getToken } = useAuth();
  const [tab, setTab] = useState<Tab>("create");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setTab("create");
      setName("");
      setCreateError(null);
      setCode("");
      setPreview(null);
      setPreviewError(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const guild = await createGuild(token, name.trim());
      onCreated(guild);
      onClose();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create server");
    } finally {
      setCreating(false);
    }
  }

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setPreviewBusy(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const token = await getToken();
      if (!token) return;
      const p = await previewInvite(token, parseInviteCode(code));
      setPreview(p);
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "Invalid or expired invite",
      );
    } finally {
      setPreviewBusy(false);
    }
  }

  async function handleJoin() {
    setJoinBusy(true);
    try {
      const token = await getToken();
      if (!token) return;
      const { guild_id } = await acceptInvite(token, parseInviteCode(code));
      onJoined(guild_id);
      onClose();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to join server");
    } finally {
      setJoinBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain noschat-app animate-rise-in relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent"
      >
        <div className="relative z-[2] flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="font-display text-2xl italic text-[#E8EAED]">
            {tab === "create" ? "Create a Server" : "Join a Server"}
          </h2>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative z-[2] flex gap-1 border-b border-white/[0.06] px-5 pt-3">
          {(["create", "join"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              data-active={tab === t}
              className="relative -mb-px px-2 pb-2.5 text-sm font-medium text-[#8B93A1] transition-colors hover:text-[#E8EAED] data-[active=true]:text-[#F0A868]"
            >
              {t === "create" ? "Create" : "Join"}
              {tab === t && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[#F0A868]" />
              )}
            </button>
          ))}
        </div>

        <div className="relative z-[2] p-5">
          {tab === "create" ? (
            <form onSubmit={handleCreate} className="space-y-3">
              <label className="block font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                Server name
              </label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Awesome Server"
                className="h-10 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus-visible:ring-[#F0A868]/25"
              />
              {createError && <p className="text-xs text-[#EB5757]">{createError}</p>}
              <Button
                type="submit"
                disabled={creating || !name.trim()}
                className="w-full"
              >
                {creating ? "Creating…" : "Create Server"}
              </Button>
            </form>
          ) : (
            <div className="space-y-3">
              <form onSubmit={handlePreview} className="flex gap-2">
                <Input
                  autoFocus
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setPreview(null);
                    setPreviewError(null);
                  }}
                  placeholder="Invite code or link"
                  className="h-10 flex-1 rounded-lg border-[#2A2F3A] bg-[#0F1217]/80 text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus-visible:ring-[#F0A868]/25"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={previewBusy || !code.trim()}
                >
                  {previewBusy ? "…" : "Preview"}
                </Button>
              </form>
              {previewError && <p className="text-xs text-[#EB5757]">{previewError}</p>}
              {preview && (
                <div className="animate-rise-in flex items-center gap-3 rounded-xl border border-[#1D2129] bg-[#12151B] px-3 py-3">
                  <span
                    className="flex size-10 flex-none items-center justify-center rounded-full font-display text-base text-[#12151A]"
                    style={{ backgroundColor: preview.icon_color }}
                  >
                    {(preview.guild_name.trim()[0] ?? "?").toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[#E8EAED]">
                      {preview.guild_name}
                    </p>
                    <p className="text-xs text-[#8B93A1]">
                      {preview.member_count} member{preview.member_count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Button size="sm" onClick={handleJoin} disabled={joinBusy}>
                    {joinBusy ? "Joining…" : "Join"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
