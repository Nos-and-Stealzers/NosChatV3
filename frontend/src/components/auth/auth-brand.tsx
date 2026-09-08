export function AuthBrand() {
  return (
    <div className="mb-8 flex items-center gap-2.5">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#5FD787] opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#5FD787]" />
      </span>
      <span className="font-mono text-sm font-semibold tracking-[0.2em] text-[#E8EAED]">
        NOSCHAT
      </span>
    </div>
  );
}

export function AuthFooterSignature() {
  return (
    <p className="mt-6 text-center font-mono text-[11px] tracking-wide text-[#8B93A1]">
      <span className="text-[#F0A868]">⦿</span> self-hosted — Clerk handles
      sign-in, your homelab handles everything else
    </p>
  );
}
