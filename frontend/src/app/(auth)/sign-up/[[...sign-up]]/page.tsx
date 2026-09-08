import { SignUp } from "@clerk/nextjs";
import { AuthBrand, AuthFooterSignature } from "@/components/auth/auth-brand";

// Canonical sign-up route — see sign-in/page.tsx for why /sign-in + /sign-up
// (not /login + /register) are the ones being kept.
export default function SignUpPage() {
  return (
    <>
      <AuthBrand />
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/"
      />
      <AuthFooterSignature />
    </>
  );
}
