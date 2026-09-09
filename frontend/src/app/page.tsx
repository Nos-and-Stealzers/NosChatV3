import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SettingsProvider } from "@/lib/settings-context";
import { RealtimeProvider } from "@/lib/realtime-context";
import { CallProvider } from "@/lib/call-context";
import { VoiceProvider } from "@/lib/voice-context";
import { DmVoiceProvider } from "@/lib/dm-voice-context";
import { PresenceProvider } from "@/lib/presence-context";
import { ContextMenuProvider } from "@/lib/context-menu";
import { AdminProvider } from "@/lib/admin-context";
import { ChatApp } from "@/components/chat-app";

// Real app: friends, DMs, realtime messaging, and Discord-style guilds
// (servers) — channels, roles, invites, voice — all wired end-to-end
// against the Rust auth-service (see backend/auth-service/src/{friends,
// dms,guilds,ws}.rs) via src/lib/backend-api.ts.
export default async function Home() {
  const { userId } = await auth();
  const user = await currentUser();
  if (!userId || !user) {
    redirect("/sign-in");
  }

  const displayName = user.firstName ?? user.username ?? "there";
  const email = user.primaryEmailAddress?.emailAddress ?? "";

  return (
    <SettingsProvider>
      <RealtimeProvider>
        <PresenceProvider>
          <CallProvider>
            <VoiceProvider>
              <DmVoiceProvider>
                <ContextMenuProvider>
                  <AdminProvider>
                    <ChatApp displayName={displayName} email={email} />
                  </AdminProvider>
                </ContextMenuProvider>
              </DmVoiceProvider>
            </VoiceProvider>
          </CallProvider>
        </PresenceProvider>
      </RealtimeProvider>
    </SettingsProvider>
  );
}
