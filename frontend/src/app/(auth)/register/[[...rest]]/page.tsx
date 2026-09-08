import { SignUp } from "@clerk/nextjs";
import { AuthBrand, AuthFooterSignature } from "@/components/auth/auth-brand";

export default function RegisterPage() {
  return (
    <>
      <AuthBrand />
      <SignUp
        routing="path"
        path="/register"
        signInUrl="/login"
        fallbackRedirectUrl="/"
      />
      <AuthFooterSignature />
    </>
  );
}
