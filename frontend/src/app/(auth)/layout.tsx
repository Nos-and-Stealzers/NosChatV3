import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#12151A] px-4 py-16">
      {/* Faint dot-grid backdrop — quiet, not decorative for its own sake:
          reads as "infrastructure" without competing with the form. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            "radial-gradient(circle, #8B93A1 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, rgba(240,168,104,0.08), transparent 70%)",
        }}
      />
      <div className="relative z-10 w-full max-w-sm">{children}</div>
    </div>
  );
}
