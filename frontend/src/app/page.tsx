import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RealtimeProvider } from "@/lib/realtime-context";
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
    redirect("/login");
  }

  const displayName = user.firstName ?? user.username ?? "there";
  const email = user.primaryEmailAddress?.emailAddress ?? "";

  return (
    <RealtimeProvider>
      <ChatApp displayName={displayName} email={email} />
    </RealtimeProvider>
  );
}
