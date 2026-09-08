import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything except the auth pages themselves (and Next internals/static
// assets) requires a signed-in Clerk session. Add more public routes here
// as they're built (e.g. a public landing page) — right now `/` just
// redirects to `/sign-in`, so there's no public page to exempt yet.
//
// Canonical auth routes are /sign-in and /sign-up (Clerk's own default
// routing convention). The earlier /login + /register pair was a
// duplicate set from an earlier session and has been deleted — don't
// re-add it here.
const isPublicRoute = createRouteMatcher([
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
