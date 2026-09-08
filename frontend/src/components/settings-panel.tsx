"use client";

// Full-screen, multi-category Settings panel — the app's Discord/Slack-style
// settings surface, built entirely in this app's own amber/near-black
// design language (see globals.css / sound-settings-dialog.tsx for the
// established chrome patterns this reuses: noschat-grain, rise-in, hairline
// borders, font-mono uppercase section labels).
//
// Architecture: a single generic renderer (`renderSetting`) drives most of
// the 100+ catalog entries directly off SETTINGS_CATALOG in
// settings-context.tsx, keyed by type (toggle/select/slider/text/color/
// time). A small number of `type: "custom"` entries need real backend/
// browser API access (sound slots, device pickers, debug displays, import/
// export, etc.) and are special-cased by id in CustomSettingBody below.

import { useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import {
  Bell,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Download,
  Keyboard,
  Loader2,
  Mic,
  Palette,
  Phone,
  Play,
  Search,
  Shield,
  Trash2,
  Upload,
  User,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CATEGORIES,
  SETTINGS_CATALOG,
  useSettings,
  type CategoryId,
  type SettingDef,
  type SettingsState,
} from "@/lib/settings-context";
import {
  MESSAGE_PRESETS,
  RINGTONE_PRESETS,
  PRESET_LABELS,
  playPreset,
  type PresetKey,
} from "@/lib/sound-presets";
import type { Friendship } from "@/lib/backend-api";
import { removeFriend } from "@/lib/backend-api";
import { WS_URL } from "@/lib/backend-api";

type SoundHook = {
  sounds: import("@/lib/backend-api").SoundsView | null;
  loading: boolean;
  error: string | null;
  choosePreset: (slot: "message" | "ringtone", preset: string) => Promise<void>;
  uploadCustom: (slot: "message" | "ringtone", file: File) => Promise<void>;
  play: (slot: "message" | "ringtone") => Promise<void>;
};

const CATEGORY_ICONS: Record<CategoryId, React.ComponentType<{ className?: string }>> = {
  account: User,
  notifications: Bell,
  appearance: Palette,
  privacy: Shield,
  calls: Phone,
  chat: Keyboard,
  developer: Code2,
};

export function SettingsPanel({
  open,
  onClose,
  initialCategory,
  sound,
  friends,
  onFriendsChanged,
  connected,
  wsDebugInfo,
  webrtcDebugInfo,
  onSimulateConnectionLoss,
  myUserId,
}: {
  open: boolean;
  onClose: () => void;
  initialCategory?: CategoryId;
  sound: SoundHook;
  friends: Friendship[];
  onFriendsChanged: () => void | Promise<void>;
  connected: boolean;
  wsDebugInfo: { lastEventType: string | null; lastEventAt: string | null; reconnectCount: number };
  webrtcDebugInfo: { iceConnectionState: string; iceGatheringState: string; signalingState: string } | null;
  onSimulateConnectionLoss: () => void;
  myUserId: string | null;
}) {
  const { settings, update } = useSettings();
  const [activeCategory, setActiveCategory] = useState<CategoryId>(initialCategory ?? "account");
  const [query, setQuery] = useState("");
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      // Jump to whichever category the caller asked for each time the panel
      // opens (e.g. the account menu opening straight to "account") rather
      // than only on first mount — the panel instance stays mounted across
      // opens/closes, so this has to re-run per open, not just once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveCategory(initialCategory ?? "account");
    }
  }, [open, initialCategory]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? SETTINGS_CATALOG.filter(
        (s) => s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      )
    : SETTINGS_CATALOG.filter((s) => s.category === activeCategory);

  const showingSearch = q.length > 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-2 backdrop-blur-[2px] sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="noschat-grain noschat-app animate-rise-in relative flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.75),0_10px_30px_-10px_rgba(240,168,104,0.10)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent sm:h-[85vh]"
      >
        {/* Header */}
        <div className="relative z-[1] flex flex-none items-center gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#8B93A1]/70">
              Preferences
            </p>
            <h2 className="font-display text-2xl italic text-[#E8EAED]">Settings</h2>
          </div>
          <div className="relative hidden max-w-xs flex-1 sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#8B93A1]/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
              className="h-8 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 pl-8 pr-2.5 text-xs text-[#E8EAED] placeholder:text-[#8B93A1]/60 outline-none focus:border-[#F0A868]/40"
            />
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close (Esc)">
            <X className="size-4" />
          </Button>
        </div>

        {/* Mobile search */}
        <div className="relative z-[1] flex-none border-b border-white/[0.06] px-4 py-2 sm:hidden">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#8B93A1]/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
              className="h-8 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 pl-8 pr-2.5 text-xs text-[#E8EAED] placeholder:text-[#8B93A1]/60 outline-none focus:border-[#F0A868]/40"
            />
          </div>
        </div>

        <div className="relative z-[1] flex min-h-0 flex-1">
          {/* Category rail — desktop */}
          <div className="noschat-scroll hidden w-56 flex-none flex-col gap-0.5 overflow-y-auto border-r border-white/[0.06] bg-black/10 p-2 sm:flex">
            {CATEGORIES.map((cat) => {
              const Icon = CATEGORY_ICONS[cat.id];
              const count = SETTINGS_CATALOG.filter((s) => s.category === cat.id).length;
              return (
                <button
                  key={cat.id}
                  onClick={() => {
                    setActiveCategory(cat.id);
                    setQuery("");
                  }}
                  data-active={!showingSearch && activeCategory === cat.id}
                  className="group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-[#8B93A1] transition-colors hover:bg-[#1B1F27] hover:text-[#E8EAED] data-[active=true]:bg-[#1B1F27] data-[active=true]:text-[#E8EAED]"
                >
                  <span className="absolute inset-y-1 left-0 w-0.5 scale-y-0 rounded-full bg-[#F0A868] transition-transform group-data-[active=true]:scale-y-100" />
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{cat.label}</span>
                  <span className="font-mono text-[9px] text-[#8B93A1]/50">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Category picker — mobile (collapsible dropdown) */}
          <div className="flex-none border-b border-white/[0.06] sm:hidden">
            <button
              onClick={() => setRailOpen((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-[#E8EAED]"
            >
              {(() => {
                const Icon = CATEGORY_ICONS[activeCategory];
                return <Icon className="size-4 text-[#F0A868]" />;
              })()}
              <span className="flex-1 text-left font-medium">
                {CATEGORIES.find((c) => c.id === activeCategory)?.label}
              </span>
              <ChevronDown className={`size-4 transition-transform ${railOpen ? "rotate-180" : ""}`} />
            </button>
            {railOpen && (
              <div className="flex flex-wrap gap-1.5 border-t border-white/[0.06] px-3 pb-3 pt-2">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => {
                      setActiveCategory(cat.id);
                      setRailOpen(false);
                      setQuery("");
                    }}
                    data-active={activeCategory === cat.id}
                    className="rounded-lg border border-[#2A2F3A] px-2.5 py-1.5 text-xs text-[#8B93A1] data-[active=true]:border-[#F0A868] data-[active=true]:text-[#F0A868]"
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Settings list */}
          <div className="noschat-scroll flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {showingSearch && (
              <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                {filtered.length} result{filtered.length === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
              </p>
            )}
            {!showingSearch && (
              <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]">
                {CATEGORIES.find((c) => c.id === activeCategory)?.label} — {filtered.length} settings
              </p>
            )}
            <div className="space-y-1">
              {filtered.map((def) => (
                <SettingRow
                  key={def.id}
                  def={def}
                  settings={settings}
                  update={update}
                  sound={sound}
                  friends={friends}
                  onFriendsChanged={onFriendsChanged}
                  connected={connected}
                  wsDebugInfo={wsDebugInfo}
                  webrtcDebugInfo={webrtcDebugInfo}
                  onSimulateConnectionLoss={onSimulateConnectionLoss}
                  myUserId={myUserId}
                  showCategoryTag={showingSearch}
                />
              ))}
              {filtered.length === 0 && (
                <p className="py-10 text-center text-sm text-[#8B93A1]">No settings match your search.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  def,
  settings,
  update,
  sound,
  friends,
  onFriendsChanged,
  connected,
  wsDebugInfo,
  webrtcDebugInfo,
  onSimulateConnectionLoss,
  myUserId,
  showCategoryTag,
}: {
  def: SettingDef;
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  sound: SoundHook;
  friends: Friendship[];
  onFriendsChanged: () => void | Promise<void>;
  connected: boolean;
  wsDebugInfo: { lastEventType: string | null; lastEventAt: string | null; reconnectCount: number };
  webrtcDebugInfo: { iceConnectionState: string; iceGatheringState: string; signalingState: string } | null;
  onSimulateConnectionLoss: () => void;
  myUserId: string | null;
  showCategoryTag: boolean;
}) {
  const wireBadge =
    def.wire === "real" ? (
      <span className="rounded-full border border-[#4ADE80]/25 bg-[#4ADE80]/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-[#4ADE80]">
        Live
      </span>
    ) : def.wire === "stub" ? (
      <span className="rounded-full border border-[#8B93A1]/25 bg-[#8B93A1]/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-[#8B93A1]">
        Not yet enforced
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-transparent px-2.5 py-3 transition-colors hover:border-[#1D2129] hover:bg-[#12151B]/60 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-sm font-medium text-[#E8EAED]">{def.label}</p>
          {wireBadge}
          {showCategoryTag && (
            <span className="rounded-full border border-[#2A2F3A] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-[#8B93A1]">
              {CATEGORIES.find((c) => c.id === def.category)?.label}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-[#8B93A1]">{def.description}</p>
      </div>
      <div className="flex flex-none items-center sm:w-72 sm:justify-end">
        {def.type === "custom" ? (
          <CustomSettingBody
            id={def.id}
            settings={settings}
            update={update}
            sound={sound}
            friends={friends}
            onFriendsChanged={onFriendsChanged}
            connected={connected}
            wsDebugInfo={wsDebugInfo}
            webrtcDebugInfo={webrtcDebugInfo}
            onSimulateConnectionLoss={onSimulateConnectionLoss}
            myUserId={myUserId}
          />
        ) : (
          <GenericControl def={def} settings={settings} update={update} />
        )}
      </div>
    </div>
  );
}

function GenericControl({
  def,
  settings,
  update,
}: {
  def: SettingDef;
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}) {
  const key = def.id as keyof SettingsState;
  const value = settings[key];

  if (def.type === "toggle") {
    const checked = Boolean(value);
    const handleToggle = () => {
      const next = !checked;
      // "Desktop notifications" needs a real browser permission prompt,
      // not just a stored boolean — request it and only flip the setting
      // on if the user actually grants permission.
      if (def.id === "desktopNotificationsEnabled" && next) {
        if (typeof Notification === "undefined") {
          window.alert("This browser doesn't support desktop notifications.");
          return;
        }
        void Notification.requestPermission().then((perm) => {
          update(key, (perm === "granted") as SettingsState[typeof key]);
        });
        return;
      }
      update(key, next as SettingsState[typeof key]);
    };
    return (
      <button
        role="switch"
        aria-checked={checked}
        onClick={handleToggle}
        data-on={checked}
        className="relative h-6 w-11 flex-none rounded-full bg-[#2A2F3A] transition-colors data-[on=true]:bg-[#F0A868]"
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#E8EAED] shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
        />
      </button>
    );
  }

  if (def.type === "select") {
    return (
      <select
        value={String(value)}
        onChange={(e) => update(key, e.target.value as SettingsState[typeof key])}
        className="h-8 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 px-2 text-xs text-[#E8EAED] outline-none focus:border-[#F0A868]/40 sm:w-44"
      >
        {def.options?.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            className="bg-[#12151B] text-[#E8EAED]"
          >
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (def.type === "color") {
    return (
      <div className="flex flex-wrap justify-end gap-1.5">
        {def.options?.map((opt) => (
          <button
            key={opt.value}
            onClick={() => update(key, opt.value as SettingsState[typeof key])}
            title={opt.label}
            data-active={value === opt.value}
            className="flex size-7 items-center justify-center rounded-full border-2 border-transparent transition-transform data-[active=true]:border-[#E8EAED] data-[active=true]:scale-110"
            style={{ backgroundColor: ACCENT_SWATCH[opt.value] ?? "#888" }}
          >
            {value === opt.value && <Check className="size-3.5 text-black/70" />}
          </button>
        ))}
      </div>
    );
  }

  if (def.type === "slider") {
    return (
      <div className="flex w-full items-center gap-2 sm:w-44">
        <input
          type="range"
          min={def.min}
          max={def.max}
          step={def.step}
          value={Number(value)}
          onChange={(e) => update(key, Number(e.target.value) as SettingsState[typeof key])}
          className="h-1.5 w-full flex-1 cursor-pointer appearance-none rounded-full bg-[#2A2F3A] accent-[#F0A868]"
        />
        <span className="w-14 flex-none text-right font-mono text-[10px] text-[#8B93A1]">
          {String(value)}
          {def.unit ?? ""}
        </span>
      </div>
    );
  }

  if (def.type === "text") {
    return (
      <input
        type="text"
        value={String(value)}
        onChange={(e) => update(key, e.target.value as SettingsState[typeof key])}
        placeholder="—"
        className="h-8 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 px-2.5 text-xs text-[#E8EAED] outline-none placeholder:text-[#8B93A1]/50 focus:border-[#F0A868]/40 sm:w-44"
      />
    );
  }

  if (def.type === "time") {
    return (
      <input
        type="time"
        value={String(value)}
        onChange={(e) => update(key, e.target.value as SettingsState[typeof key])}
        className="h-8 rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 px-2.5 text-xs text-[#E8EAED] outline-none focus:border-[#F0A868]/40"
      />
    );
  }

  return null;
}

const ACCENT_SWATCH: Record<string, string> = {
  amber: "#F0A868",
  teal: "#5FD9C4",
  violet: "#A283EE",
  rose: "#EE7FAA",
  blue: "#6FA5EE",
  green: "#86D468",
};

// --- Custom (type:"custom") setting bodies --------------------------------
// Every one of these does something real (backend call, browser API,
// localStorage op, real display), or is honestly labeled read-only/stub in
// its rendered text — never a silently-fake control.

function CustomSettingBody({
  id,
  settings,
  update,
  sound,
  friends,
  onFriendsChanged,
  connected,
  wsDebugInfo,
  webrtcDebugInfo,
  onSimulateConnectionLoss,
  myUserId,
}: {
  id: string;
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  sound: SoundHook;
  friends: Friendship[];
  onFriendsChanged: () => void | Promise<void>;
  connected: boolean;
  wsDebugInfo: { lastEventType: string | null; lastEventAt: string | null; reconnectCount: number };
  webrtcDebugInfo: { iceConnectionState: string; iceGatheringState: string; signalingState: string } | null;
  onSimulateConnectionLoss: () => void;
  myUserId: string | null;
}) {
  const { openUserProfile } = useClerk();
  const { resetAll, exportJson, importJson, localStorageUsageBytes } = useSettings();

  switch (id) {
    case "copyUserId":
      return <CopyUserIdControl myUserId={myUserId} />;

    case "manageSessions":
    case "twoFactorAuth":
    case "twoFactorAuthPrivacy":
      return (
        <Button size="sm" variant="secondary" onClick={() => openUserProfile()}>
          Open account settings
        </Button>
      );

    case "deleteAccount":
      return (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => openUserProfile({ __experimental_startPath: "/security" } as never)}
        >
          <Trash2 className="size-3.5" /> Manage / delete
        </Button>
      );

    case "soundMessageBeep":
      return (
        <SlotEditor
          presets={MESSAGE_PRESETS}
          current={sound.sounds?.message.preset ?? null}
          hasCustom={sound.sounds?.message.has_custom ?? false}
          onChoose={(p) => void sound.choosePreset("message", p)}
          onUpload={(f) => void sound.uploadCustom("message", f)}
          onPreview={() => void sound.play("message")}
        />
      );

    case "soundRingtone":
      return (
        <SlotEditor
          presets={RINGTONE_PRESETS}
          current={sound.sounds?.ringtone.preset ?? null}
          hasCustom={sound.sounds?.ringtone.has_custom ?? false}
          onChoose={(p) => void sound.choosePreset("ringtone", p)}
          onUpload={(f) => void sound.uploadCustom("ringtone", f)}
          onPreview={() => void sound.play("ringtone")}
        />
      );

    case "blockedUsersList":
      return <BlockedUsersControl friends={friends} onFriendsChanged={onFriendsChanged} />;

    case "dataExportRequest":
      return (
        <Button size="sm" variant="secondary" disabled title="Not implemented">
          Not implemented
        </Button>
      );

    case "defaultMicDeviceId":
      return <DevicePicker kind="audioinput" settings={settings} update={update} />;

    case "defaultCameraDeviceId":
      return <DevicePicker kind="videoinput" settings={settings} update={update} />;

    case "micTestTone":
      return (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => playPreset("chime" as PresetKey)}
        >
          <Play className="size-3.5" /> Play test tone
        </Button>
      );

    case "iceServerDisplay": {
      const raw = process.env.NEXT_PUBLIC_ICE_SERVERS;
      let display = "stun:stun.l.google.com:19302 (default)";
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          display = JSON.stringify(parsed);
        } catch {
          display = "invalid NEXT_PUBLIC_ICE_SERVERS (falling back to default STUN)";
        }
      }
      return (
        <code className="block max-w-full truncate rounded-lg border border-[#2A2F3A] bg-[#0F1217]/60 px-2.5 py-1.5 font-mono text-[10px] text-[#8B93A1]">
          {display}
        </code>
      );
    }

    case "apiBaseUrlDisplay": {
      const authUrl = process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? "http://localhost:4000";
      return (
        <div className="space-y-1 text-right">
          <code className="block font-mono text-[10px] text-[#8B93A1]">HTTP: {authUrl}</code>
          <code className="block font-mono text-[10px] text-[#8B93A1]">WS: {WS_URL}</code>
        </div>
      );
    }

    case "buildVersionDisplay":
      return (
        <div className="space-y-0.5 text-right">
          <code className="block font-mono text-[10px] text-[#8B93A1]">app v0.1.0</code>
          <code className="block font-mono text-[10px] text-[#8B93A1]">Next.js 16.3.1 · React 19.2.8</code>
        </div>
      );

    case "resetAllSettings":
      return (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => {
            if (window.confirm("Reset all settings to their defaults?")) resetAll();
          }}
        >
          <Trash2 className="size-3.5" /> Reset
        </Button>
      );

    case "exportSettingsJson":
      return (
        <Button size="sm" variant="secondary" onClick={exportJson}>
          <Download className="size-3.5" /> Export JSON
        </Button>
      );

    case "importSettingsJson":
      return <ImportSettingsControl importJson={importJson} />;

    case "simulateConnectionLoss":
      return (
        <Button size="sm" variant="secondary" onClick={onSimulateConnectionLoss} disabled={!connected}>
          Force disconnect
        </Button>
      );

    case "pingLatencyDisplay":
      return (
        <span className="text-xs text-[#8B93A1]">Unavailable — no ping/pong protocol on the socket yet.</span>
      );

    case "localStorageUsageDisplay":
      return (
        <code className="font-mono text-[10px] text-[#8B93A1]">
          {(localStorageUsageBytes / 1024).toFixed(2)} KB
        </code>
      );

    case "reconnectCounterDisplay":
      return <code className="font-mono text-[10px] text-[#8B93A1]">{wsDebugInfo.reconnectCount}</code>;

    case "clearMessageCache":
      return (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("noschat:clear-message-cache"));
          }}
        >
          Clear cache
        </Button>
      );

    default:
      return <span className="text-xs text-[#8B93A1]/50">—</span>;
  }
}

function CopyUserIdControl({ myUserId }: { myUserId: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        if (!myUserId) return;
        await navigator.clipboard.writeText(myUserId);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      disabled={!myUserId}
    >
      <Copy className="size-3.5" /> {copied ? "Copied!" : "Copy ID"}
    </Button>
  );
}

function BlockedUsersControl({
  friends,
  onFriendsChanged,
}: {
  friends: Friendship[];
  onFriendsChanged: () => void | Promise<void>;
}) {
  const { getToken } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);
  const accepted = friends.filter((f) => f.status === "accepted");
  if (accepted.length === 0) {
    return <p className="text-xs text-[#8B93A1]">No friends to remove yet.</p>;
  }
  return (
    <div className="w-full max-w-sm space-y-1">
      {accepted.map((f) => (
        <div
          key={f.id}
          className="flex items-center justify-between gap-2 rounded-lg border border-[#2A2F3A] bg-[#0F1217]/60 px-2.5 py-1.5"
        >
          <span className="truncate text-xs text-[#E8EAED]">{f.username ?? f.email}</span>
          <Button
            size="xs"
            variant="destructive"
            disabled={busyId === f.id}
            onClick={async () => {
              setBusyId(f.id);
              try {
                const token = await getToken();
                if (token) {
                  await removeFriend(token, f.id);
                  await onFriendsChanged();
                }
              } finally {
                setBusyId(null);
              }
            }}
          >
            {busyId === f.id ? <Loader2 className="size-3 animate-spin" /> : "Remove"}
          </Button>
        </div>
      ))}
    </div>
  );
}

function ImportSettingsControl({
  importJson,
}: {
  importJson: (file: File) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-[10px] text-[#8B93A1]">{msg}</span>}
      <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-[#2A2F3A] px-2.5 py-1.5 text-xs text-[#8B93A1] hover:border-[#F0A868]/40 hover:text-[#F0A868]">
        <Upload className="size-3.5" /> Import…
        <input
          type="file"
          accept="application/json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const res = await importJson(file);
            setMsg(res.ok ? "Imported ✓" : (res.error ?? "Failed"));
            setTimeout(() => setMsg(null), 2500);
          }}
        />
      </label>
    </div>
  );
}

function DevicePicker({
  kind,
  settings,
  update,
}: {
  kind: "audioinput" | "videoinput";
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = kind === "audioinput" ? "defaultMicDeviceId" : "defaultCameraDeviceId";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Request a short-lived permission grant so labels are populated
        // (enumerateDevices alone returns blank labels pre-permission).
        const constraint = kind === "audioinput" ? { audio: true } : { video: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraint);
        stream.getTracks().forEach((t) => t.stop());
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all.filter((d) => d.kind === kind));
      } catch (e) {
        if (!cancelled) {
          try {
            const all = await navigator.mediaDevices.enumerateDevices();
            setDevices(all.filter((d) => d.kind === kind));
          } catch {
            setError(e instanceof Error ? e.message : "Could not enumerate devices");
          }
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  if (error) return <span className="text-xs text-[#EB5757]">{error}</span>;

  return (
    <select
      value={settings[key]}
      onChange={(e) => update(key, e.target.value as SettingsState[typeof key])}
      className="h-8 w-full max-w-56 rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 px-2 text-xs text-[#E8EAED] outline-none focus:border-[#F0A868]/40"
    >
      <option value="" className="bg-[#12151B] text-[#E8EAED]">
        System default
      </option>
      {devices.map((d) => (
        <option
          key={d.deviceId}
          value={d.deviceId}
          className="bg-[#12151B] text-[#E8EAED]"
        >
          {d.label || `${kind === "audioinput" ? "Microphone" : "Camera"} ${d.deviceId.slice(0, 6)}`}
        </option>
      ))}
    </select>
  );
}

function SlotEditor({
  presets,
  current,
  hasCustom,
  onChoose,
  onUpload,
  onPreview,
}: {
  presets: PresetKey[];
  current: string | null;
  hasCustom: boolean;
  onChoose: (preset: string) => void;
  onUpload: (file: File) => void;
  onPreview: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => onChoose(p)}
            data-active={!hasCustom && current === p}
            className="rounded-lg border border-[#2A2F3A] bg-[#12151A] px-2.5 py-1 text-[11px] text-[#8B93A1] transition-colors hover:border-[#F0A868]/40 hover:text-[#E8EAED] data-[active=true]:border-[#F0A868] data-[active=true]:bg-[#F0A868]/10 data-[active=true]:text-[#F0A868]"
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
        <label
          data-active={hasCustom}
          className="group flex cursor-pointer items-center gap-1 rounded-lg border border-dashed border-[#2A2F3A] px-2.5 py-1 text-[11px] text-[#8B93A1] transition-colors hover:border-[#F0A868]/40 hover:text-[#F0A868] data-[active=true]:border-solid data-[active=true]:border-[#F0A868] data-[active=true]:bg-[#F0A868]/10 data-[active=true]:text-[#F0A868]"
        >
          {hasCustom ? (
            <>
              <Check className="size-3" /> Custom
            </>
          ) : (
            <>
              <Upload className="size-3" />
              {uploading ? "…" : "Upload"}
            </>
          )}
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.target.value = "";
            }}
          />
        </label>
        <Button size="xs" variant="ghost" onClick={onPreview} className="gap-1">
          <Play className="size-3" />
        </Button>
      </div>
    </div>
  );
}

// Re-exported so any consumer that only needs the mic icon (unused
// currently, reserved for the device-picker header) shares one import.
export { Mic, Volume2 };
