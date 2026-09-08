"use client";

// App-wide confirm dialog chrome — this codebase deliberately never uses
// window.confirm() (see settings-panel.tsx's own note on custom modal
// chrome), so every destructive action (delete message, leave/delete guild,
// etc.) should route through this instead. Mirrors the visual language of
// settings-panel.tsx / create-join-guild-modal.tsx: grain overlay, rise-in,
// amber/near-black gradient card.

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain animate-pop-in relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-5 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent"
      >
        <div className="relative z-[1] flex items-start gap-3">
          <span
            className={`flex size-9 flex-none items-center justify-center rounded-full ${destructive ? "bg-[#EB5757]/15 text-[#EB5757]" : "bg-[#F0A868]/15 text-[#F0A868]"}`}
          >
            <AlertTriangle className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1 pt-1">
            <h3 className="text-sm font-semibold text-[#E8EAED]">{title}</h3>
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-[#8B93A1]">{description}</p>
            )}
          </div>
        </div>
        <div className="relative z-[1] mt-5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
