"use client";

// "New Group DM" modal — multi-select friend picker matching Discord's
// group DM creation flow. Styling/chrome mirrors create-join-guild-modal.tsx
// (rise-in, backdrop-click-to-close, Escape-to-close).

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { X, Users, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClickableAvatar } from "@/components/profile-card";
import { createGroupDm, type Friendship } from "@/lib/backend-api";

const MAX_OTHERS = 9; // + the caller = 10 total, matching the backend cap.

export function NewGroupDmModal({
  open,
  onClose,
  friends,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  friends: Friendship[];
  onCreated: (dmId: string) => void;
}) {
  const { getToken } = useAuth();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptedFriends = friends.filter((f) => f.status === "accepted");

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
      setSelected(new Set());
      setFilter("");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else if (next.size < MAX_OTHERS) {
        next.add(userId);
      }
      return next;
    });
  }

  async function handleCreate() {
    if (selected.size < 2) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const { id } = await createGroupDm(token, Array.from(selected));
      onCreated(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group DM");
    } finally {
      setBusy(false);
    }
  }

  const visible = acceptedFriends.filter((f) => {
    if (!filter.trim()) return true;
    const label = (f.username ?? f.email).toLowerCase();
    return label.includes(filter.trim().toLowerCase());
  });

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain noschat-app animate-rise-in relative flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent"
      >
        <div className="relative z-[2] flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="font-display text-2xl italic text-[#E8EAED]">
            New Group DM
          </h2>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative z-[2] flex flex-col gap-3 overflow-hidden p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
            Select 2–{MAX_OTHERS} friends — {selected.size} selected
          </p>
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search friends…"
            className="h-10 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 px-3 text-sm text-[#E8EAED] placeholder:text-[#8B93A1]/60 outline-none focus:border-[#F0A868]/40"
          />

          <div className="noschat-scroll flex-1 space-y-1 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#2A2F3A] px-4 py-8 text-center">
                <Users className="mx-auto mb-2 size-6 text-[#8B93A1]/50" />
                <p className="text-sm text-[#8B93A1]">
                  {acceptedFriends.length === 0
                    ? "Add some friends first."
                    : "No friends match your search."}
                </p>
              </div>
            ) : (
              visible.map((f) => {
                const label = f.username ?? f.email;
                const isSelected = selected.has(f.user_id);
                const disabled = !isSelected && selected.size >= MAX_OTHERS;
                return (
                  <div
                    key={f.user_id}
                    role="button"
                    tabIndex={disabled ? -1 : 0}
                    aria-disabled={disabled}
                    onClick={() => {
                      if (!disabled) toggle(f.user_id);
                    }}
                    onKeyDown={(e) => {
                      if (!disabled && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        toggle(f.user_id);
                      }
                    }}
                    data-active={isSelected}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-[#1B1F27] data-[active=true]:border-[#F0A868]/30 data-[active=true]:bg-[#1E232C] aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                  >
                    <ClickableAvatar userId={f.user_id} label={label} size="sm" showStatus={false} />
                    <span className="min-w-0 flex-1 truncate text-sm text-[#E8EAED]">
                      {label}
                    </span>
                    <span
                      className="flex size-5 flex-none items-center justify-center rounded-full border border-[#2A2F3A] text-[#12151A] transition-colors group-data-[active=true]:border-[#F0A868] group-data-[active=true]:bg-[#F0A868]"
                      data-active={isSelected}
                    >
                      {isSelected && <Check className="size-3" />}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {error && <p className="text-xs text-[#EB5757]">{error}</p>}

          <Button
            onClick={handleCreate}
            disabled={busy || selected.size < 2}
            className="w-full"
          >
            {busy ? "Creating…" : "Create Group DM"}
          </Button>
        </div>
      </div>
    </div>
  );
}
