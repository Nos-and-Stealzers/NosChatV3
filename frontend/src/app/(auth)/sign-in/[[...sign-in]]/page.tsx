import { SignIn } from "@clerk/nextjs";
import { AuthBrand, AuthFooterSignature } from "@/components/auth/auth-brand";

// Canonical sign-in route. Clerk's <SignIn /> requires a catch-all segment
// ([[...sign-in]]) so it can render its internal steps (password,
// verification code, SSO callback, etc.) as sub-paths under /sign-in
// without separate pages for each. Mirrored under /sign-up.
//
// This pair (/sign-in, /sign-up) is the ONLY canonical auth path in the
// app — the earlier /login and /register pages were a duplicate set from
// an earlier session and have been removed. Keep this pair because it
// matches Clerk's own default routing conventions (what `clerk init` and
// Clerk's docs assume), which keeps NEXT_PUBLIC_CLERK_SIGN_IN_URL /
// NEXT_PUBLIC_CLERK_SIGN_UP_URL, `signInUrl`/`signUpUrl` props, and
// Clerk's own internal redirects (e.g. after email verification) all
// consistent without extra path-mapping.
export default function SignInPage() {
  return (
    <>
      <AuthBrand />
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/"
      />
      <AuthFooterSignature />
    </>
  );
}
