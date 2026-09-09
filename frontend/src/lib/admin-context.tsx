"use client";

// Tiny site-wide "am I staff" context — a single source of truth so any
// component (ClickableAvatar's admin right-click menu, etc.) can check
// staff status without re-fetching or threading a prop through every
// call site. Real data only: backed by the same GET /admin/me the
// StaffPanel gate already uses (admin.rs's require_staff on the backend
// re-checks independently on every actual admin action — this context is
// just "should the UI even offer the option", not a security boundary).
import { createContext, useContext, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { adminWhoAmI } from "@/lib/backend-api";

const AdminContext = createContext<{ isStaff: boolean }>({ isStaff: false });

export function useIsStaff(): boolean {
  return useContext(AdminContext).isStaff;
}

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const [isStaff, setIsStaff] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const res = await adminWhoAmI(token);
        if (!cancelled) setIsStaff(res.is_staff);
      } catch {
        // Not staff (403) or transient failure — either way, default to
        // false rather than showing admin UI on a guess.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, getToken]);

  return <AdminContext.Provider value={{ isStaff }}>{children}</AdminContext.Provider>;
}
