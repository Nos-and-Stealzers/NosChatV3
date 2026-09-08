"use client";

// Single shared client-side settings store for the whole app. Mirrors the
// Provider pattern used by realtime-context.tsx / call-context.tsx:
// createContext + a hook, persisted to localStorage under one key, with a
// handful of settings that also drive real, visible side effects (accent
// color, density, font scale, motion, grain) applied directly to
// document.documentElement so plain CSS in globals.css can react to them
// without every component needing to know about settings.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type CategoryId =
  | "account"
  | "notifications"
  | "appearance"
  | "privacy"
  | "calls"
  | "chat"
  | "developer";

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "account", label: "Account & Profile" },
  { id: "notifications", label: "Notifications & Sounds" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy & Safety" },
  { id: "calls", label: "Calls & Media" },
  { id: "chat", label: "Chat & Messages" },
  { id: "developer", label: "Developer" },
];

export type AccentColor = "amber" | "teal" | "violet" | "rose" | "blue" | "green";
export type Density = "compact" | "comfortable" | "spacious";
export type FontScale = "small" | "medium" | "large";
export type SidebarWidth = "compact" | "default" | "wide";
export type CornerStyle = "sharp" | "rounded" | "pill";
export type FontFamilyChoice = "geist" | "system" | "mono";

export interface SettingsState {
  // --- Account & Profile ---
  displayNameOverride: string;
  profileVisibility: "everyone" | "friends" | "nobody";
  statusMessage: string;
  timezone: string;
  locale: string;
  avatarStyle: "initials" | "gradient" | "geometric";
  emailVisibleToFriends: boolean;
  showAccountCreationDate: boolean;
  compactProfileCard: boolean;
  pronouns: string;
  bio: string;
  showBirthdate: boolean;

  // --- Notifications & Sounds ---
  notificationVolume: number; // 0-100
  desktopNotificationsEnabled: boolean;
  muteAll: boolean;
  notifyNewMessage: boolean;
  notifyFriendRequest: boolean;
  notifyFriendAccepted: boolean;
  notifyIncomingCall: boolean;
  notificationPreviewText: boolean;
  dndEnabled: boolean;
  dndStart: string; // HH:MM
  dndEnd: string; // HH:MM
  soundOnOwnSentMessage: boolean;
  badgeCountEnabled: boolean;
  groupedNotifications: boolean;
  vibrateOnMobile: boolean;
  showTypingInNotifications: boolean;

  // --- Appearance ---
  accentColor: AccentColor;
  messageDensity: Density;
  fontSizeScale: FontScale;
  reduceMotion: boolean;
  grainTexture: boolean;
  timestampFormat: "12h" | "24h";
  showAvatarsInMessages: boolean;
  sidebarWidth: SidebarWidth;
  themeBrightness: number; // 80-120 (%)
  themeContrast: number; // 80-120 (%)
  animatedTypingDots: boolean;
  boldUnreadDm: boolean;
  compactSidebarIcons: boolean;
  showSignalDot: boolean;
  messageCornerStyle: CornerStyle;
  fontFamilyChoice: FontFamilyChoice;
  highContrastText: boolean;
  showGradientBackgrounds: boolean;
  compactHeaderHeight: boolean;
  uppercaseSectionLabels: boolean;

  // --- Privacy & Safety ---
  readReceiptsEnabled: boolean;
  typingIndicatorEnabled: boolean;
  appearOffline: boolean;
  screenShareConfirmPrompt: boolean;
  linkPreviewGeneration: boolean;
  profileSearchable: boolean;
  showLastSeenToFriends: boolean;
  requireFriendRequestApproval: boolean;
  autoDeclineUnknownDms: boolean;
  sensitiveContentBlur: boolean;
  shareTypingAcrossDevices: boolean;
  anonymizeAvatarInPreview: boolean;

  // --- Calls & Media ---
  defaultMicDeviceId: string; // "" = system default
  defaultCameraDeviceId: string; // "" = system default
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  defaultCallType: "voice" | "video";
  autoAcceptCallsFromFriends: boolean;
  screenShareResolution: "720p" | "1080p" | "1440p";
  screenShareFrameRate: 15 | 30 | 60;
  ringtoneVolume: number; // 0-100
  cameraPreviewOnHover: boolean;
  callWaitingTone: boolean;
  autoMuteOnJoin: boolean;
  videoQualityCap: "480p" | "720p" | "1080p";

  // --- Chat & Messages ---
  sendOnEnter: boolean;
  messageGroupingWindowMin: number; // 1-15
  spellcheckEnabled: boolean;
  typingIndicatorDelayMs: number; // 500-5000
  maxMessageLengthWarning: number; // chars
  linkAutoDetection: boolean;
  inlineMediaPreview: boolean;
  composerAutoFocus: boolean;
  unreadBadgeStyle: "dot" | "count";
  sortDmsBy: "recent" | "alphabetical";
  showTypingIndicatorText: boolean;
  showMessageTimestampsAlways: boolean;
  composerPlaceholderStyle: "formal" | "casual";
  pasteAsPlainText: boolean;
  confirmBeforeLeavingUnsent: boolean;
  showLastMessagePreview: boolean;

  // --- Developer ---
  wsDebugOverlay: boolean;
  verboseLogging: boolean;
  showWebrtcState: boolean;
  forceTurnRelay: boolean;
  logNetworkEvents: boolean;
  debugShowUserId: boolean;
}

export const DEFAULT_SETTINGS: SettingsState = {
  displayNameOverride: "",
  profileVisibility: "friends",
  statusMessage: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  locale: "en-US",
  avatarStyle: "gradient",
  emailVisibleToFriends: false,
  showAccountCreationDate: true,
  compactProfileCard: false,
  pronouns: "",
  bio: "",
  showBirthdate: false,

  notificationVolume: 80,
  desktopNotificationsEnabled: false,
  muteAll: false,
  notifyNewMessage: true,
  notifyFriendRequest: true,
  notifyFriendAccepted: true,
  notifyIncomingCall: true,
  notificationPreviewText: true,
  dndEnabled: false,
  dndStart: "22:00",
  dndEnd: "08:00",
  soundOnOwnSentMessage: false,
  badgeCountEnabled: true,
  groupedNotifications: true,
  vibrateOnMobile: true,
  showTypingInNotifications: false,

  accentColor: "amber",
  messageDensity: "comfortable",
  fontSizeScale: "medium",
  reduceMotion: false,
  grainTexture: true,
  timestampFormat: "12h",
  showAvatarsInMessages: true,
  sidebarWidth: "default",
  themeBrightness: 100,
  themeContrast: 100,
  animatedTypingDots: true,
  boldUnreadDm: true,
  compactSidebarIcons: false,
  showSignalDot: true,
  messageCornerStyle: "rounded",
  fontFamilyChoice: "geist",
  highContrastText: false,
  showGradientBackgrounds: true,
  compactHeaderHeight: false,
  uppercaseSectionLabels: true,

  readReceiptsEnabled: true,
  typingIndicatorEnabled: true,
  appearOffline: false,
  screenShareConfirmPrompt: true,
  linkPreviewGeneration: false,
  profileSearchable: true,
  showLastSeenToFriends: true,
  requireFriendRequestApproval: true,
  autoDeclineUnknownDms: false,
  sensitiveContentBlur: false,
  shareTypingAcrossDevices: true,
  anonymizeAvatarInPreview: false,

  defaultMicDeviceId: "",
  defaultCameraDeviceId: "",
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  defaultCallType: "voice",
  autoAcceptCallsFromFriends: false,
  screenShareResolution: "1080p",
  screenShareFrameRate: 30,
  ringtoneVolume: 90,
  cameraPreviewOnHover: true,
  callWaitingTone: false,
  autoMuteOnJoin: false,
  videoQualityCap: "720p",

  sendOnEnter: true,
  messageGroupingWindowMin: 5,
  spellcheckEnabled: true,
  typingIndicatorDelayMs: 2000,
  maxMessageLengthWarning: 2000,
  linkAutoDetection: false,
  inlineMediaPreview: false,
  composerAutoFocus: true,
  unreadBadgeStyle: "count",
  sortDmsBy: "recent",
  showTypingIndicatorText: true,
  showMessageTimestampsAlways: false,
  composerPlaceholderStyle: "casual",
  pasteAsPlainText: true,
  confirmBeforeLeavingUnsent: false,
  showLastMessagePreview: true,

  wsDebugOverlay: false,
  verboseLogging: false,
  showWebrtcState: false,
  forceTurnRelay: false,
  logNetworkEvents: false,
  debugShowUserId: false,
};

export type SettingType =
  | "toggle"
  | "select"
  | "slider"
  | "text"
  | "color"
  | "time"
  | "custom";

export type WireKind = "real" | "local" | "stub";

export type SettingOption = { value: string; label: string };

export interface SettingDef {
  id: string; // key of SettingsState, or a custom id for type:"custom"
  category: CategoryId;
  label: string;
  description: string;
  type: SettingType;
  wire: WireKind;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

// The full catalog drives both search/filter and generic rendering. Custom
// items (sound slots, device pickers, blocked-users list, read-only debug
// displays, buttons, import/export) are declared here for search purposes
// and special-cased in settings-panel.tsx by id.
export const SETTINGS_CATALOG: SettingDef[] = [
  // Account & Profile (16)
  { id: "displayNameOverride", category: "account", label: "Display name override", description: "Shown instead of your Clerk profile name inside NosChat only.", type: "text", wire: "local" },
  { id: "profileVisibility", category: "account", label: "Profile visibility", description: "Who can see your profile details.", type: "select", wire: "local", options: [{ value: "everyone", label: "Everyone" }, { value: "friends", label: "Friends only" }, { value: "nobody", label: "Nobody" }] },
  { id: "statusMessage", category: "account", label: "Status message", description: "A short custom status shown near your name.", type: "text", wire: "local" },
  { id: "timezone", category: "account", label: "Timezone", description: "Used for local-only display purposes (detected automatically).", type: "select", wire: "local", options: ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Europe/Madrid", "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney"].map((z) => ({ value: z, label: z })) },
  { id: "locale", category: "account", label: "Language / locale", description: "Affects date/number formatting preferences stored locally.", type: "select", wire: "local", options: [{ value: "en-US", label: "English (US)" }, { value: "en-GB", label: "English (UK)" }, { value: "es-ES", label: "Español" }, { value: "fr-FR", label: "Français" }, { value: "de-DE", label: "Deutsch" }, { value: "ja-JP", label: "日本語" }, { value: "pt-BR", label: "Português (BR)" }] },
  { id: "avatarStyle", category: "account", label: "Avatar style", description: "Visual treatment for auto-generated avatars.", type: "select", wire: "local", options: [{ value: "initials", label: "Initials" }, { value: "gradient", label: "Gradient" }, { value: "geometric", label: "Geometric" }] },
  { id: "emailVisibleToFriends", category: "account", label: "Show email to friends", description: "Let accepted friends see your email address.", type: "toggle", wire: "local" },
  { id: "showAccountCreationDate", category: "account", label: "Show account creation date", description: "Display when your account was created on your profile card.", type: "toggle", wire: "local" },
  { id: "compactProfileCard", category: "account", label: "Compact profile card", description: "Use a denser layout for your own profile summary.", type: "toggle", wire: "local" },
  { id: "pronouns", category: "account", label: "Pronouns", description: "Optional, shown next to your display name.", type: "text", wire: "local" },
  { id: "bio", category: "account", label: "Bio", description: "A short personal bio, stored locally for now.", type: "text", wire: "local" },
  { id: "showBirthdate", category: "account", label: "Show birthdate on profile", description: "No birthdate field exists in the backend yet.", type: "toggle", wire: "stub" },
  { id: "copyUserId", category: "account", label: "Copy your user ID", description: "Copies your real backend user id to the clipboard.", type: "custom", wire: "real" },
  { id: "presenceAndProfile", category: "account", label: "Presence & profile", description: "Set your status (online/idle/dnd/invisible), bio, pronouns, status message, and profile colors — synced to the real backend and visible to friends live.", type: "custom", wire: "real" },
  { id: "manageSessions", category: "account", label: "Manage account & sessions", description: "Opens Clerk's account portal (security / sessions tab).", type: "custom", wire: "real" },
  { id: "twoFactorAuth", category: "account", label: "Two-factor authentication", description: "Opens Clerk's account security settings.", type: "custom", wire: "real" },
  { id: "deleteAccount", category: "account", label: "Delete account", description: "Opens Clerk's account portal to permanently delete your account.", type: "custom", wire: "real" },

  // Notifications & Sounds (18, incl. 2 embedded slot editors)
  { id: "soundMessageBeep", category: "notifications", label: "Message beep", description: "Preset, upload, and preview your incoming-message sound.", type: "custom", wire: "real" },
  { id: "soundRingtone", category: "notifications", label: "Ringtone", description: "Preset, upload, and preview your incoming-call sound.", type: "custom", wire: "real" },
  { id: "notificationVolume", category: "notifications", label: "Notification volume", description: "Scales the volume of message/friend-request sounds.", type: "slider", wire: "real", min: 0, max: 100, step: 5, unit: "%" },
  { id: "desktopNotificationsEnabled", category: "notifications", label: "Desktop notifications", description: "Requests real browser notification permission.", type: "toggle", wire: "real" },
  { id: "muteAll", category: "notifications", label: "Mute all sounds", description: "Silences every in-app sound regardless of other settings.", type: "toggle", wire: "real" },
  { id: "notifyNewMessage", category: "notifications", label: "Notify on new message", description: "Play a sound when a new DM message arrives.", type: "toggle", wire: "real" },
  { id: "notifyFriendRequest", category: "notifications", label: "Notify on friend request", description: "Play a sound when someone sends you a friend request.", type: "toggle", wire: "real" },
  { id: "notifyFriendAccepted", category: "notifications", label: "Notify on friend accepted", description: "Alert you when a friend request you sent is accepted.", type: "toggle", wire: "local" },
  { id: "notifyIncomingCall", category: "notifications", label: "Notify on incoming call", description: "Ring when a friend calls you.", type: "toggle", wire: "real" },
  { id: "notificationPreviewText", category: "notifications", label: "Show message preview in notifications", description: "No OS push-notification pipeline exists yet — local preference only.", type: "toggle", wire: "stub" },
  { id: "dndEnabled", category: "notifications", label: "Do Not Disturb schedule", description: "Stores a DND window; not enforced at the OS level.", type: "toggle", wire: "local" },
  { id: "dndStart", category: "notifications", label: "DND start time", description: "When your do-not-disturb window begins.", type: "time", wire: "local" },
  { id: "dndEnd", category: "notifications", label: "DND end time", description: "When your do-not-disturb window ends.", type: "time", wire: "local" },
  { id: "soundOnOwnSentMessage", category: "notifications", label: "Play sound for my own sent messages", description: "Also beep when you send a message, not just receive one.", type: "toggle", wire: "real" },
  { id: "badgeCountEnabled", category: "notifications", label: "Unread badge in tab title", description: "Shows your total unread count in the browser tab title.", type: "toggle", wire: "real" },
  { id: "groupedNotifications", category: "notifications", label: "Group notifications by conversation", description: "No OS notification stack exists yet — local preference only.", type: "toggle", wire: "stub" },
  { id: "vibrateOnMobile", category: "notifications", label: "Vibrate on mobile", description: "Uses navigator.vibrate() where supported.", type: "toggle", wire: "real" },
  { id: "showTypingInNotifications", category: "notifications", label: "Include typing status in notifications", description: "No push notifications exist yet — local preference only.", type: "toggle", wire: "stub" },

  // Appearance (20)
  { id: "accentColor", category: "appearance", label: "Accent color", description: "Swaps the app's amber accent for an alternate palette everywhere.", type: "color", wire: "real", options: [{ value: "amber", label: "Amber" }, { value: "teal", label: "Teal" }, { value: "violet", label: "Violet" }, { value: "rose", label: "Rose" }, { value: "blue", label: "Blue" }, { value: "green", label: "Green" }] },
  { id: "messageDensity", category: "appearance", label: "Message density", description: "Controls spacing between messages and groups.", type: "select", wire: "real", options: [{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "spacious", label: "Spacious" }] },
  { id: "fontSizeScale", category: "appearance", label: "Font size", description: "Scales base text size across the whole app.", type: "select", wire: "real", options: [{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }] },
  { id: "reduceMotion", category: "appearance", label: "Reduce motion", description: "Disables rise-in, pulse, and typing-dot animations.", type: "toggle", wire: "real" },
  { id: "grainTexture", category: "appearance", label: "Grain texture", description: "Toggles the subtle noise texture on dark panels.", type: "toggle", wire: "real" },
  { id: "timestampFormat", category: "appearance", label: "Timestamp format", description: "12-hour or 24-hour clock for message times.", type: "select", wire: "real", options: [{ value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" }] },
  { id: "showAvatarsInMessages", category: "appearance", label: "Show avatars in message list", description: "Hide the small avatar next to grouped messages.", type: "toggle", wire: "real" },
  { id: "sidebarWidth", category: "appearance", label: "Sidebar width", description: "Adjusts the DM/friends list panel width.", type: "select", wire: "real", options: [{ value: "compact", label: "Compact" }, { value: "default", label: "Default" }, { value: "wide", label: "Wide" }] },
  { id: "themeBrightness", category: "appearance", label: "Brightness", description: "Applies a CSS brightness filter to the whole app.", type: "slider", wire: "real", min: 80, max: 120, step: 5, unit: "%" },
  { id: "themeContrast", category: "appearance", label: "Contrast", description: "Applies a CSS contrast filter to the whole app.", type: "slider", wire: "real", min: 80, max: 120, step: 5, unit: "%" },
  { id: "animatedTypingDots", category: "appearance", label: "Animated typing dots", description: "Disable to show a static \"typing…\" label instead.", type: "toggle", wire: "real" },
  { id: "boldUnreadDm", category: "appearance", label: "Bold unread conversations", description: "Bold the DM name when it has unread messages.", type: "toggle", wire: "real" },
  { id: "compactSidebarIcons", category: "appearance", label: "Compact rail icons", description: "Shrinks the left app-switcher rail.", type: "toggle", wire: "real" },
  { id: "showSignalDot", category: "appearance", label: "Show live connection dot", description: "Hide the green/gray websocket status dot.", type: "toggle", wire: "real" },
  { id: "messageCornerStyle", category: "appearance", label: "Message bubble corners", description: "Sharp, rounded, or pill-shaped message bubbles.", type: "select", wire: "real", options: [{ value: "sharp", label: "Sharp" }, { value: "rounded", label: "Rounded" }, { value: "pill", label: "Pill" }] },
  { id: "fontFamilyChoice", category: "appearance", label: "Font family", description: "Switches the app's body font.", type: "select", wire: "real", options: [{ value: "geist", label: "Geist Sans" }, { value: "system", label: "System UI" }, { value: "mono", label: "Monospace" }] },
  { id: "highContrastText", category: "appearance", label: "High contrast text", description: "Brightens secondary/muted text for readability.", type: "toggle", wire: "real" },
  { id: "showGradientBackgrounds", category: "appearance", label: "Gradient backgrounds", description: "Use gradients on avatars and the sent-message bubble.", type: "toggle", wire: "real" },
  { id: "compactHeaderHeight", category: "appearance", label: "Compact header height", description: "Shrinks the top header bar in each panel.", type: "toggle", wire: "real" },
  { id: "uppercaseSectionLabels", category: "appearance", label: "Uppercase section labels", description: "Toggle the tracked-uppercase style on section headers.", type: "toggle", wire: "real" },

  // Privacy & Safety (15)
  { id: "readReceiptsEnabled", category: "privacy", label: "Send read receipts", description: "When off, opening a DM no longer marks it read on the server.", type: "toggle", wire: "real" },
  { id: "typingIndicatorEnabled", category: "privacy", label: "Broadcast typing indicator", description: "When off, the app stops sending typing events to the server.", type: "toggle", wire: "real" },
  { id: "appearOffline", category: "privacy", label: "Appear offline", description: "Local-only flag — not yet enforced by the backend for other users.", type: "toggle", wire: "stub" },
  { id: "screenShareConfirmPrompt", category: "privacy", label: "Confirm before screen sharing", description: "Shows a confirmation dialog before starting a screen share.", type: "toggle", wire: "real" },
  { id: "linkPreviewGeneration", category: "privacy", label: "Generate link previews", description: "No link preview feature exists yet.", type: "toggle", wire: "stub" },
  { id: "blockedUsersList", category: "privacy", label: "Blocked / removed users", description: "Remove friends using the real backend endpoint.", type: "custom", wire: "real" },
  { id: "profileSearchable", category: "privacy", label: "Profile searchable by username", description: "No user search/discovery feature exists yet.", type: "toggle", wire: "stub" },
  { id: "showLastSeenToFriends", category: "privacy", label: "Show last-seen to friends", description: "Tied to Appear Offline; not backend-enforced yet.", type: "toggle", wire: "stub" },
  { id: "requireFriendRequestApproval", category: "privacy", label: "Require approval for friend requests", description: "This is already the app's real behavior (requests need accept).", type: "toggle", wire: "stub" },
  { id: "autoDeclineUnknownDms", category: "privacy", label: "Auto-decline DMs from non-friends", description: "The app only supports DMs with friends already, so this is a no-op placeholder.", type: "toggle", wire: "stub" },
  { id: "sensitiveContentBlur", category: "privacy", label: "Blur sensitive media by default", description: "No inline media rendering exists yet.", type: "toggle", wire: "stub" },
  { id: "shareTypingAcrossDevices", category: "privacy", label: "Share typing status across my devices", description: "Local preference; single-session app currently.", type: "toggle", wire: "stub" },
  { id: "anonymizeAvatarInPreview", category: "privacy", label: "Anonymize avatar in previews", description: "No external preview surface exists yet.", type: "toggle", wire: "stub" },
  { id: "dataExportRequest", category: "privacy", label: "Request a data export", description: "Not implemented — no export pipeline exists on the backend.", type: "custom", wire: "stub" },
  { id: "twoFactorAuthPrivacy", category: "privacy", label: "Manage login security", description: "Opens Clerk's real account security settings.", type: "custom", wire: "real" },

  // Calls & Media (17)
  { id: "defaultMicDeviceId", category: "calls", label: "Microphone", description: "Selected device is passed as the real audio deviceId constraint.", type: "custom", wire: "real" },
  { id: "defaultCameraDeviceId", category: "calls", label: "Camera", description: "Selected device is passed as the real video deviceId constraint.", type: "custom", wire: "real" },
  { id: "echoCancellation", category: "calls", label: "Echo cancellation", description: "Real getUserMedia audio constraint.", type: "toggle", wire: "real" },
  { id: "noiseSuppression", category: "calls", label: "Noise suppression", description: "Real getUserMedia audio constraint.", type: "toggle", wire: "real" },
  { id: "autoGainControl", category: "calls", label: "Auto gain control", description: "Real getUserMedia audio constraint.", type: "toggle", wire: "real" },
  { id: "defaultCallType", category: "calls", label: "Default call type", description: "Which call button is emphasized when starting a call.", type: "select", wire: "local", options: [{ value: "voice", label: "Voice" }, { value: "video", label: "Video" }] },
  { id: "autoAcceptCallsFromFriends", category: "calls", label: "Auto-accept calls from friends", description: "Not wired — too risky to the existing call state machine to auto-answer.", type: "toggle", wire: "stub" },
  { id: "screenShareResolution", category: "calls", label: "Screen share resolution", description: "Real getDisplayMedia video constraint.", type: "select", wire: "real", options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }, { value: "1440p", label: "1440p" }] },
  { id: "screenShareFrameRate", category: "calls", label: "Screen share frame rate", description: "Real getDisplayMedia frameRate constraint.", type: "select", wire: "real", options: [{ value: "15", label: "15 fps" }, { value: "30", label: "30 fps" }, { value: "60", label: "60 fps" }] },
  { id: "ringtoneVolume", category: "calls", label: "Ringtone volume", description: "Scales the volume of the incoming-call ringtone.", type: "slider", wire: "real", min: 0, max: 100, step: 5, unit: "%" },
  { id: "micTestTone", category: "calls", label: "Play test tone", description: "Plays a short real tone through your speakers to check audio output.", type: "custom", wire: "real" },
  { id: "iceServerDisplay", category: "calls", label: "ICE servers in use", description: "Read-only display of the configured STUN/TURN servers.", type: "custom", wire: "real" },
  { id: "cameraPreviewOnHover", category: "calls", label: "Camera preview on hover", description: "No hover-preview surface exists yet.", type: "toggle", wire: "stub" },
  { id: "callWaitingTone", category: "calls", label: "Call waiting tone", description: "No call-waiting/second-call feature exists yet.", type: "toggle", wire: "stub" },
  { id: "autoMuteOnJoin", category: "calls", label: "Auto-mute microphone on join", description: "Real: mutes your mic automatically the moment a call connects.", type: "toggle", wire: "real" },
  { id: "videoQualityCap", category: "calls", label: "Video quality cap", description: "Real getUserMedia video resolution constraint.", type: "select", wire: "real", options: [{ value: "480p", label: "480p" }, { value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }] },

  // Chat & Messages (16)
  { id: "sendOnEnter", category: "chat", label: "Send on Enter", description: "When off, use Shift+Enter to send and Enter for a newline.", type: "toggle", wire: "real" },
  { id: "messageGroupingWindowMin", category: "chat", label: "Message grouping window", description: "Consecutive messages within this window collapse into one group.", type: "slider", wire: "real", min: 1, max: 15, step: 1, unit: " min" },
  { id: "spellcheckEnabled", category: "chat", label: "Spellcheck in composer", description: "Sets the real spellCheck attribute on the message box.", type: "toggle", wire: "real" },
  { id: "typingIndicatorDelayMs", category: "chat", label: "Typing indicator throttle", description: "Minimum time between typing events sent to the server.", type: "slider", wire: "real", min: 500, max: 5000, step: 250, unit: "ms" },
  { id: "maxMessageLengthWarning", category: "chat", label: "Message length warning threshold", description: "Shows a warning near the composer past this length.", type: "slider", wire: "real", min: 200, max: 4000, step: 100, unit: " chars" },
  { id: "linkAutoDetection", category: "chat", label: "Auto-detect links", description: "No linkification feature exists yet.", type: "toggle", wire: "stub" },
  { id: "inlineMediaPreview", category: "chat", label: "Inline media previews", description: "No inline media rendering exists yet.", type: "toggle", wire: "stub" },
  { id: "composerAutoFocus", category: "chat", label: "Auto-focus composer on DM open", description: "Focuses the message box automatically when you open a conversation.", type: "toggle", wire: "real" },
  { id: "unreadBadgeStyle", category: "chat", label: "Unread badge style", description: "Show unread counts as a number or a simple dot.", type: "select", wire: "real", options: [{ value: "count", label: "Count" }, { value: "dot", label: "Dot" }] },
  { id: "sortDmsBy", category: "chat", label: "Sort conversations by", description: "Most recent activity, or alphabetically by name.", type: "select", wire: "real", options: [{ value: "recent", label: "Recent activity" }, { value: "alphabetical", label: "Alphabetical" }] },
  { id: "showTypingIndicatorText", category: "chat", label: "Show \"is typing…\" text", description: "Hide the typing label in the conversation list and header.", type: "toggle", wire: "real" },
  { id: "showMessageTimestampsAlways", category: "chat", label: "Always show message timestamps", description: "Show timestamps at all times instead of only on hover.", type: "toggle", wire: "real" },
  { id: "composerPlaceholderStyle", category: "chat", label: "Composer placeholder style", description: "Formal (\"Message X\") or casual (\"Say something to X…\").", type: "select", wire: "real", options: [{ value: "formal", label: "Formal" }, { value: "casual", label: "Casual" }] },
  { id: "pasteAsPlainText", category: "chat", label: "Paste as plain text", description: "Strips formatting from pasted clipboard content.", type: "toggle", wire: "real" },
  { id: "confirmBeforeLeavingUnsent", category: "chat", label: "Warn before closing tab with unsent text", description: "Real beforeunload confirmation when the composer isn't empty.", type: "toggle", wire: "real" },
  { id: "showLastMessagePreview", category: "chat", label: "Show last message preview", description: "Hide the message preview text in the conversation list.", type: "toggle", wire: "real" },

  // Developer (16)
  { id: "wsDebugOverlay", category: "developer", label: "WebSocket debug overlay", description: "Shows a floating panel with live connection state, last event, and reconnect count.", type: "toggle", wire: "real" },
  { id: "verboseLogging", category: "developer", label: "Verbose console logging", description: "Logs every realtime event and call-signaling message to the console.", type: "toggle", wire: "real" },
  { id: "showWebrtcState", category: "developer", label: "Show raw WebRTC state", description: "Adds ICE connection/gathering and signaling state to the debug overlay during a call.", type: "toggle", wire: "real" },
  { id: "apiBaseUrlDisplay", category: "developer", label: "API base URL", description: "Read-only display of the configured auth-service/WS URLs.", type: "custom", wire: "real" },
  { id: "buildVersionDisplay", category: "developer", label: "Build & version info", description: "Read-only display of app/Next.js/React versions.", type: "custom", wire: "real" },
  { id: "forceTurnRelay", category: "developer", label: "Force TURN-relay-only ICE", description: "Sets RTCPeerConnection iceTransportPolicy to \"relay\" for the next call.", type: "toggle", wire: "real" },
  { id: "resetAllSettings", category: "developer", label: "Reset all settings", description: "Clears every stored preference back to defaults.", type: "custom", wire: "real" },
  { id: "exportSettingsJson", category: "developer", label: "Export settings as JSON", description: "Downloads your current settings state as a .json file.", type: "custom", wire: "real" },
  { id: "importSettingsJson", category: "developer", label: "Import settings from JSON", description: "Validates and applies a previously exported settings file.", type: "custom", wire: "real" },
  { id: "simulateConnectionLoss", category: "developer", label: "Simulate connection loss", description: "Forcibly closes the live WebSocket to test reconnect logic.", type: "custom", wire: "real" },
  { id: "pingLatencyDisplay", category: "developer", label: "Ping / latency", description: "No ping/pong protocol is implemented on the socket, so this is honestly unavailable.", type: "custom", wire: "stub" },
  { id: "localStorageUsageDisplay", category: "developer", label: "Local storage usage", description: "Real computed byte size of this app's localStorage keys.", type: "custom", wire: "real" },
  { id: "reconnectCounterDisplay", category: "developer", label: "Reconnect counter", description: "Real count of WebSocket reconnect attempts this session.", type: "custom", wire: "real" },
  { id: "logNetworkEvents", category: "developer", label: "Log network/API calls", description: "Adds a console.debug line for backend-api.ts requests.", type: "toggle", wire: "real" },
  { id: "debugShowUserId", category: "developer", label: "Show my user ID in overlay", description: "Adds your real backend user id to the debug overlay.", type: "toggle", wire: "real" },
  { id: "clearMessageCache", category: "developer", label: "Clear in-memory message cache", description: "Drops all locally cached DM messages, forcing a refetch on next open.", type: "custom", wire: "real" },
];

export const STORAGE_KEY = "noschat:settings:v1";

type SettingsContextValue = {
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  resetAll: () => void;
  exportJson: () => void;
  importJson: (file: File) => Promise<{ ok: boolean; error?: string }>;
  localStorageUsageBytes: number;
  reconnectCount: number;
  bumpReconnectCount: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

function loadInitial(): SettingsState {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function computeLocalStorageBytes(): number {
  if (typeof window === "undefined") return 0;
  let total = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith("noschat:")) continue;
    const value = window.localStorage.getItem(key) ?? "";
    total += key.length + value.length;
  }
  return total * 2; // rough UTF-16 byte estimate
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<SettingsState>(() => loadInitial());
  const [storageBytes, setStorageBytes] = useState(0);
  const [reconnectCount, setReconnectCount] = useState(0);
  const hydrated = useRef(false);

  useEffect(() => {
    // Deliberate one-time hydration from localStorage on mount (client-only
    // data source, not something React can read during SSR) — safe to
    // treat as an exception to the "don't setState in an effect" guidance
    // since there's no alternative for bridging a browser-only API into
    // React state before first paint.
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadInitial());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStorageBytes(computeLocalStorageBytes());
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStorageBytes(computeLocalStorageBytes());
    } catch {
      // storage full/unavailable — settings just won't persist this time
    }
  }, [settings]);

  // Real, visible side effects applied to the document root so CSS in
  // globals.css can react to them anywhere in the tree.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-accent", settings.accentColor);
    root.setAttribute("data-font-scale", settings.fontSizeScale);
    root.setAttribute("data-reduce-motion", settings.reduceMotion ? "on" : "off");
    root.setAttribute("data-grain", settings.grainTexture ? "on" : "off");
    root.setAttribute("data-font-family", settings.fontFamilyChoice);
    root.setAttribute("data-high-contrast", settings.highContrastText ? "on" : "off");
    root.setAttribute("data-uppercase-labels", settings.uppercaseSectionLabels ? "on" : "off");
    root.style.filter = `brightness(${settings.themeBrightness}%) contrast(${settings.themeContrast}%)`;
  }, [
    settings.accentColor,
    settings.fontSizeScale,
    settings.reduceMotion,
    settings.grainTexture,
    settings.fontFamilyChoice,
    settings.highContrastText,
    settings.uppercaseSectionLabels,
    settings.themeBrightness,
    settings.themeContrast,
  ]);

  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const resetAll = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSettings(DEFAULT_SETTINGS);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `noschat-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file: File): Promise<{ ok: boolean; error?: string }> => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "File does not contain a settings object." };
      }
      // Only accept known keys, ignore anything unrecognized/malicious.
      const next: SettingsState = { ...DEFAULT_SETTINGS };
      const nextRecord = next as unknown as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsState)[]) {
        if (key in parsed) {
          nextRecord[key] = (parsed as Record<string, unknown>)[key];
        }
      }
      setSettings(next);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON file." };
    }
  };

  const bumpReconnectCount = () => setReconnectCount((c) => c + 1);

  const value = useMemo(
    () => ({
      settings,
      update,
      resetAll,
      exportJson,
      importJson,
      localStorageUsageBytes: storageBytes,
      reconnectCount,
      bumpReconnectCount,
    }),
    [settings, storageBytes, reconnectCount],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
