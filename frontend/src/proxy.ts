import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything except the auth pages themselves (and Next internals/static
// assets) requires a signed-in Clerk session. Add more public routes here
// as they're built (e.g. a public landing page) — right now `/` just
// redirects to `/login`, so there's no public page to exempt yet.
//
// Both /login+/register (the original Clerk pages) and /sign-in+/sign-up
// (added later, and what NEXT_PUBLIC_CLERK_SIGN_IN_URL/SIGN_UP_URL in
// frontend/.env.local actually point Clerk's unauthenticated redirect at)
// are listed here — the previous version only listed /login+/register,
// which meant an unauthenticated hit to /sign-in got protect()-ed, which
// redirected back to /sign-in?redirect_url=..., which got protect()-ed
// again, forever (ERR_TOO_MANY_REDIRECTS). Keeping both pairs public until
// one pair is deliberately removed.
const isPublicRoute = createRouteMatcher([
  "/login(.*)",
  "/register(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
    // Always run for Clerk-specific frontend API routes
    "/__clerk/(.*)",
  ],
};
