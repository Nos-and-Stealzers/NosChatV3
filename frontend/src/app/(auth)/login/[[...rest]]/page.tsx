import { SignIn } from "@clerk/nextjs";
import { AuthBrand, AuthFooterSignature } from "@/components/auth/auth-brand";

// Catch-all route ([[...rest]]) is required by Clerk's <SignIn /> so it can
// render its internal steps (password, verification code, SSO callback,
// etc.) as sub-paths under /login without us building separate pages for
// each. Same pattern mirrored under /register.
export default function LoginPage() {
  return (
    <>
      <AuthBrand />
      <SignIn
        routing="path"
        path="/login"
        signUpUrl="/register"
        fallbackRedirectUrl="/"
      />
      <AuthFooterSignature />
    </>
  );
}
