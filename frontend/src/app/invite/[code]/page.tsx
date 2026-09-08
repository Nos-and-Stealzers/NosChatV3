"use client";

// Public-facing invite landing page — Discord's `discord.gg/xyz` pattern.
// This route is intentionally left OUT of proxy.ts's public-route list, so
// Clerk's middleware protects it like everything else: a signed-out visitor
// hitting /invite/CODE is bounced to /sign-in (or /sign-up) and automatically
// returned to this exact URL after authenticating, then lands here to
// preview and join. That round-trip is what makes a shared invite link work
// for someone who doesn't have an account yet, without any extra plumbing —
// Clerk's own redirect_url handling does it for free.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { previewInvite, acceptInvite, type InvitePreview } from "@/lib/backend-api";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";

export default function InvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const router = useRouter();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const p = await previewInvite(token, code);
        setPreview(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : "This invite is invalid or has expired.");
      }
    })();
  }, [isLoaded, isSignedIn, getToken, code]);

  async function handleJoin() {
    setJoining(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await acceptInvite(token, code);
      // Land on the main app — chat-app.tsx's own guild list will pick up
      // the new membership on its next fetch. Passing the guild id via a
      // query param is a possible follow-up if we want it to auto-select,
      // but landing on "/" with the sidebar refreshed is enough for now.
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join this server.");
      setJoining(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#12151A] px-4 py-16">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage: "radial-gradient(circle, #8B93A1 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(60% 50% at 50% 0%, rgba(240,168,104,0.08), transparent 70%)",
        }}
      />

      <div className="noschat-grain noschat-app animate-rise-in relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-6 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent">
        <p className="mb-4 text-center font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
          You've been invited to join
        </p>

        {error ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-sm text-[#EB5757]">{error}</p>
            <Button variant="secondary" onClick={() => router.push("/")}>
              Go to NosChat
            </Button>
          </div>
        ) : !preview ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="size-16 animate-pulse rounded-full bg-[#2A2F3A]" />
            <p className="text-sm text-[#8B93A1]">Loading invite…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <span
              className="flex size-16 items-center justify-center rounded-full font-display text-2xl text-[#12151A] shadow-[0_1px_0_rgba(255,255,255,0.3)_inset]"
              style={{ backgroundColor: preview.icon_color }}
            >
              {(preview.guild_name.trim()[0] ?? "?").toUpperCase()}
            </span>
            <h1 className="font-display text-2xl italic text-[#E8EAED]">
              {preview.guild_name}
            </h1>
            <div className="flex items-center gap-1.5 text-xs text-[#8B93A1]">
              <Users className="size-3.5" />
              {preview.member_count} member{preview.member_count === 1 ? "" : "s"}
            </div>
            <Button onClick={handleJoin} disabled={joining} className="mt-2 w-full">
              {joining ? "Joining…" : "Accept Invite"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
