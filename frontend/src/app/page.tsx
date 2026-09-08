import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SettingsProvider } from "@/lib/settings-context";
import { RealtimeProvider } from "@/lib/realtime-context";
import { CallProvider } from "@/lib/call-context";
import { ChatApp } from "@/components/chat-app";

// Real app: friends, DMs, and realtime messaging, wired end-to-end against
// the Rust auth-service (see backend/auth-service/src/{friends,dms,ws}.rs)
// via src/lib/backend-api.ts. Communities/channels from the earlier
// proof-of-concept shell are gone for now — friends + DMs was the actual
// point (see chat history) and channel/community-service was never built.
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
        <CallProvider>
          <ChatApp displayName={displayName} email={email} />
        </CallProvider>
      </RealtimeProvider>
    </SettingsProvider>
  );
}
