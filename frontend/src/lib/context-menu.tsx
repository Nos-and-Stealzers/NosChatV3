"use client";

// A single, app-wide custom right-click context menu system — replaces the
// browser's native context menu everywhere in NosChatV3 with a Discord-
// style dark popover menu of relevant actions. One <ContextMenuProvider>
// mounted once near the app root owns all menu state/positioning/
// dismissal; any component calls the `useContextMenu()` hook's `open()`
// function from an onContextMenu handler to show a menu built from a list
// of items at the cursor position. This keeps every call site tiny (just
// build an item array) while keeping positioning/dismiss-on-click-outside/
// viewport-clamping/escape-to-close logic in exactly one place.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";

export type ContextMenuItem =
  | { kind: "separator" }
  | { kind: "label"; label: string }
  | {
      kind: "item";
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      shortcut?: string;
    };

type MenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

type ContextMenuContextValue = {
  open: (e: { clientX: number; clientY: number }, items: ContextMenuItem[]) => void;
  close: () => void;
};

const ContextMenuCtx = createContext<ContextMenuContextValue | null>(null);

export function useContextMenu(): ContextMenuContextValue {
  const ctx = useContext(ContextMenuCtx);
  if (!ctx) {
    throw new Error("useContextMenu() must be used within <ContextMenuProvider>");
  }
  return ctx;
}

// Convenience wrapper: spreads onto any element to override its native
// right-click with a menu built by `buildItems()`. Usage:
//   <div {...contextMenuProps(() => [...])}>...</div>
export function useContextMenuHandler() {
  const { open } = useContextMenu();
  return useCallback(
    (buildItems: () => ContextMenuItem[]) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        open(e, buildItems());
      },
    [open],
  );
}

const MENU_WIDTH = 220;
const MENU_MARGIN = 8;

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = useCallback(
    (e: { clientX: number; clientY: number }, items: ContextMenuItem[]) => {
      if (items.length === 0) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Rough height estimate for viewport clamping (real height is
      // measured post-mount below for a second, more accurate pass).
      const estHeight = items.length * 32 + 16;
      const x = Math.min(e.clientX, vw - MENU_WIDTH - MENU_MARGIN);
      const y = Math.min(e.clientY, vh - estHeight - MENU_MARGIN);
      setMenu({ x: Math.max(MENU_MARGIN, x), y: Math.max(MENU_MARGIN, y), items });
    },
    [],
  );

  const close = useCallback(() => setMenu(null), []);

  // Re-clamp against actual measured height once the menu is in the DOM —
  // the estimate above is close but item icons/wrapping can shift it.
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let { x, y } = menu;
    if (rect.bottom > vh - MENU_MARGIN) y = Math.max(MENU_MARGIN, vh - rect.height - MENU_MARGIN);
    if (rect.right > vw - MENU_MARGIN) x = Math.max(MENU_MARGIN, vw - rect.width - MENU_MARGIN);
    if (x !== menu.x || y !== menu.y) setMenu((m) => (m ? { ...m, x, y } : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.items]);

  useEffect(() => {
    if (!menu) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onScroll() {
      close();
    }
    function onContextMenuElsewhere(e: MouseEvent) {
      // A second right-click outside the open menu should close it (not
      // stack) — the new target's own handler (if any) will open a fresh
      // one on the next event tick.
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("contextmenu", onContextMenuElsewhere);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("contextmenu", onContextMenuElsewhere);
    };
  }, [menu, close]);

  return (
    <ContextMenuCtx.Provider value={{ open, close }}>
      {children}
      {menu && (
        <div
          ref={menuRef}
          style={{ position: "fixed", left: menu.x, top: menu.y, width: MENU_WIDTH, zIndex: 200 }}
          className="animate-pop-in overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-1 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_20px_50px_-15px_rgba(0,0,0,0.75)]"
        >
          {menu.items.map((item, i) => {
            if (item.kind === "separator") {
              return <div key={i} className="my-1 h-px bg-white/[0.06]" />;
            }
            if (item.kind === "label") {
              return (
                <p key={i} className="px-2.5 pt-1.5 pb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8B93A1]/70">
                  {item.label}
                </p>
              );
            }
            const Icon = item.icon;
            return (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  item.danger
                    ? "text-[#EB5757] hover:bg-[#EB5757]/10"
                    : "text-[#E8EAED] hover:bg-[#F0A868]/10 hover:text-[#F0A868]"
                }`}
              >
                {Icon && <Icon className="size-3.5 flex-none" />}
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="flex-none font-mono text-[10px] text-[#8B93A1]/70">{item.shortcut}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </ContextMenuCtx.Provider>
  );
}
