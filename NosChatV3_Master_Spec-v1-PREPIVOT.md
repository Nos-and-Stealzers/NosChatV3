# NosChatV3 — Master Product & Architecture Specification

> **Version:** 1.0  
> **Status:** Active Development  
> **Classification:** Internal — Engineering & Product

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Core Design Principles](#2-core-design-principles)
3. [Technology Stack](#3-technology-stack)
4. [Authentication](#4-authentication)
5. [Frontend](#5-frontend)
6. [Backend](#6-backend)
7. [Data & Storage](#7-data--storage)
8. [Real-Time Infrastructure](#8-real-time-infrastructure)
9. [User & Account System](#9-user--account-system)
10. [Community System](#10-community-system)
11. [Channel System](#11-channel-system)
12. [Messaging System](#12-messaging-system)
13. [Voice & Video](#13-voice--video)
14. [Permissions & Roles](#14-permissions--roles)
15. [Moderation System](#15-moderation-system)
16. [Notifications](#16-notifications)
17. [Search](#17-search)
18. [File Sharing](#18-file-sharing)
19. [Social Features](#19-social-features)
20. [Bot & Developer Platform](#20-bot--developer-platform)
21. [AI Features](#21-ai-features)
22. [Security & Privacy](#22-security--privacy)
23. [Performance Goals](#23-performance-goals)
24. [Firebase Policy](#24-firebase-policy)
25. [Phased Development Plan](#25-phased-development-plan)
26. [Architectural Decisions Log](#26-architectural-decisions-log)

---

## 1. Project Overview

**NosChatV3** is a next-generation real-time communication, community, collaboration, and social platform designed to compete with and surpass Discord, Slack, Microsoft Teams, Telegram Communities, and similar platforms.

### Target Audience

| Segment | Use Case |
|---|---|
| Gamers & Communities | Public/private servers, voice chat, screen sharing |
| Developers & Teams | Workspaces, integrations, bots, webhooks |
| Enterprises | Secure workspaces, compliance, audit logging |
| Creators | Live streaming, events, stage channels |
| General Social | Friend networks, DMs, group chats |

### Platform Support

| Platform | Target | Priority |
|---|---|---|
| Web | Chrome, Firefox, Safari, Edge | P0 |
| Windows | Native desktop via Tauri | P0 |
| macOS | Native desktop via Tauri | P0 |
| Android | Flutter mobile | P0 |
| iOS | Flutter mobile | P0 |
| Linux | Native desktop via Tauri | P1 |

---

## 2. Core Design Principles

### 2.1 Real-Time First

Every user interaction must propagate instantly to all connected clients. No feature should feel "laggy" or require a page refresh.

**Real-time required for:**
- Online presence & green status indicators
- Typing indicators
- Read receipts
- Message delivery, edits, and deletes
- Reactions
- Voice and video activity states
- Screen sharing state changes
- Role and permission changes
- Notification delivery

### 2.2 Platform Independence

One codebase, one ecosystem, every device. Users must be able to switch from mobile to desktop to web without losing context, messages, or state.

### 2.3 Massive Scalability

The architecture must be **horizontally scalable from day one**.

| Metric | Target |
|---|---|
| Registered Users | 1,000,000+ |
| Concurrent Users | 100,000+ |
| Daily Messages | Millions |
| Simultaneous Voice Channels | Thousands |
| Simultaneous Video Sessions | Thousands |

### 2.4 Data Ownership

NosChatV3 owns all critical application data. No core platform functionality may depend on third-party managed databases that could introduce lock-in or SLA risk.

### 2.5 Minimal Vendor Lock-In

Where third-party services are used, they must be replaceable. Prefer open-source or self-hostable alternatives wherever possible (e.g. MinIO instead of R2, Valkey instead of Redis).

---

## 3. Technology Stack

### Summary Table

| Layer | Technology | Rationale |
|---|---|---|
| Frontend Framework | Flutter | Single codebase, native performance, cross-platform |
| Desktop Shell | Tauri v2 (Rust) | Lightweight, secure, native OS integration |
| Backend Language | Rust | Memory safety, performance, concurrency |
| Backend Framework | Axum | Async, ergonomic, battle-tested with Tokio |
| Runtime | Tokio | Async I/O, task scheduling |
| Primary Database | PostgreSQL | ACID compliance, relational, battle-tested |
| Cache / Pub-Sub | Redis | Sub-millisecond reads, pub/sub for real-time |
| Search | OpenSearch | Full-text search, scalable indexing |
| Analytics | ClickHouse | Columnar, blazing-fast OLAP queries |
| File Storage | Cloudflare R2 / MinIO | S3-compatible, egress-free (R2) |
| Real-Time Transport | WebSockets + Redis Pub/Sub | Low latency, fan-out messaging |
| Voice & Video | WebRTC | Peer-to-peer + SFU for group calls |
| Authentication | Clerk | Full-featured auth-as-a-service |
| Push Notifications | Firebase Cloud Messaging | Industry standard, broad device support |

---

## 4. Authentication

### 4.1 Provider: Clerk

All authentication is handled exclusively via **Clerk**. No other auth provider is permitted for core user identity.

**Clerk responsibilities:**
- User signup and login flows
- Password reset
- Multi-Factor Authentication (MFA/TOTP)
- Passkey (WebAuthn) support
- OAuth provider integrations
- Session token issuance and management
- User metadata management

**Backend responsibility:**
- Validate Clerk-issued JWTs on every authenticated API request
- Extract user identity from validated JWT claims
- Never store raw passwords or manage sessions independently

### 4.2 Supported OAuth Providers

| Provider | Priority |
|---|---|
| Google | Required |
| Apple | Required |
| GitHub | Required |
| Microsoft | Required |
| Steam | Supported |
| Twitch | Supported |
| Discord (Import) | Supported |
| Reddit | Supported |
| X (Twitter) | Supported |
| LinkedIn | Future |
| TikTok | Future |

### 4.3 What Is Forbidden

- Firebase Authentication
- Supabase Authentication
- Auth0 (unless replacing Clerk as a full migration)
- Rolling custom JWT issuance without Clerk

---

## 5. Frontend

### 5.1 Framework: Flutter

Flutter is the single frontend framework for all platforms (web, mobile, desktop). Business logic and UI are shared across targets with minimal platform-specific shims.

### 5.2 Desktop: Tauri v2

The desktop shell uses **Tauri v2** with a **Rust** native layer. Flutter renders via a WebView embedded in the Tauri window. The Rust layer handles:
- OS notifications
- System tray
- Auto-updater
- File system access
- Native window management

### 5.3 State Management

To be decided per team convention. Recommended options: Riverpod or Bloc. Consistency across the codebase is required — do not mix patterns.

### 5.4 Design System

A shared design system must be built and maintained. All UI components (buttons, inputs, modals, channel lists, message bubbles) must come from this system. No ad-hoc styling outside the design tokens.

---

## 6. Backend

### 6.1 Language & Framework

| Component | Choice |
|---|---|
| Language | Rust |
| Framework | Axum |
| Async Runtime | Tokio |
| ORM / Query Builder | sqlx (async, compile-time checked) |
| Serialization | serde + serde_json |
| WebSocket | tokio-tungstenite |
| JWT Validation | jsonwebtoken crate (validates Clerk JWTs) |

### 6.2 API Surface

Three API interfaces will be exposed:

| Interface | Use Case |
|---|---|
| REST API | Standard CRUD, resource management |
| GraphQL API | Flexible queries for complex frontends |
| WebSocket Gateway | Real-time event streaming |

All APIs must be versioned (`/v1/`, `/v2/`).

### 6.3 Service Architecture

NosChatV3 should be built as **modular services** (not a monolith, not full microservices initially). Services:

- `auth-service` — JWT validation, session context
- `user-service` — Profiles, friends, presence
- `community-service` — Community/server management
- `channel-service` — Channel CRUD, permissions
- `message-service` — Message CRUD, history, search
- `voice-service` — WebRTC signaling
- `notification-service` — Push, email, in-app
- `file-service` — Upload, scan, delivery
- `search-service` — OpenSearch integration
- `analytics-service` — ClickHouse write path
- `moderation-service` — Automod, reports, actions
- `bot-service` — Bot accounts, slash commands, webhooks

---

## 7. Data & Storage

### 7.1 PostgreSQL (Primary Database)

PostgreSQL is the **source of truth** for all persistent data.

**Stores:**
- Users and profiles
- Communities (servers)
- Channels
- Messages
- Roles and permissions
- Relationships (friends, blocks)
- Audit logs
- Bot registrations
- Events

**Requirements:**
- Connection pooling via `PgBouncer` or `sqlx` pool
- Read replicas for high-traffic read paths
- Migrations managed via `sqlx migrate` or `Flyway`

### 7.2 Redis (Cache & Pub/Sub)

Redis serves as the real-time backbone alongside caching.

**Stores:**
- User presence states
- Typing indicator events (ephemeral, TTL ~5s)
- Session metadata
- Rate limiting counters
- Pub/Sub channels for WebSocket fan-out
- Temporary feature flags

**Note:** Redis data is ephemeral and non-authoritative. PostgreSQL remains the source of truth.

### 7.3 OpenSearch (Search Engine)

**Indexes:**
- Messages (full-text)
- Communities (discovery)
- Users (username, display name)
- Channels
- Files and attachments

### 7.4 ClickHouse (Analytics)

**Tracks:**
- Daily active users (DAU)
- Monthly active users (MAU)
- Session analytics
- Engagement metrics
- Retention cohorts
- Performance metrics

### 7.5 File Storage

**Primary:** Cloudflare R2 (S3-compatible, no egress fees)  
**Alternative / Self-hosted:** MinIO

**Stored assets:**
- User avatars and banners
- Attachment images, videos, documents
- Audio messages
- Community assets
- Sticker and emoji packs

**File pipeline:**
1. Client requests presigned upload URL from `file-service`
2. Client uploads directly to R2/MinIO
3. `file-service` confirms receipt, runs virus scan, extracts metadata
4. Compressed/resized thumbnails generated
5. CDN URL returned to client

---

## 8. Real-Time Infrastructure

### 8.1 WebSocket Gateway

All clients maintain a persistent WebSocket connection to the gateway.

**Event flow:**
```
Client → WebSocket Gateway → Redis Pub/Sub → Target WebSocket Connections
```

**Gateway responsibilities:**
- Authenticate connection via Clerk JWT
- Subscribe client to relevant Redis channels (user, community, DM)
- Fan out incoming events to subscribed clients
- Handle reconnection and missed-event recovery

### 8.2 Presence System

| Status | Description |
|---|---|
| Online | Active connection, interacting |
| Idle | Connected but inactive (auto after ~10 min) |
| Do Not Disturb | Connected, suppresses notifications |
| Invisible | Connected but appears offline to others |
| Offline | No active connection |

**Device indicators:** Mobile 📱 / Desktop 🖥️ / Web 🌐

Presence updates must propagate in **under 500ms** to all relevant clients.

### 8.3 Typing Indicators

- Published via WebSocket to the channel's Redis pub/sub topic
- **Never stored in PostgreSQL** — ephemeral only
- Auto-expire after 5 seconds of no new typing event
- Batch multiple typists: "Alice and Bob are typing…"

### 8.4 Read Receipts

- Tracked via **last-read message ID** per user per channel
- `POST /channels/{id}/ack` with `message_id`
- Unread count computed from `messages.id > last_read_id`

### 8.5 Future: QUIC Transport

QUIC (HTTP/3) transport will replace WebSockets for reduced connection latency and better mobile network handling. Planned for Phase 4.

---

## 9. User & Account System

### 9.1 User Profile Fields

| Field | Notes |
|---|---|
| Username | Unique, lowercase, alphanumeric + underscores |
| Display Name | Free-form, shown in UI |
| Bio | Up to 500 characters |
| Avatar | Image URL (stored in R2) |
| Banner | Profile banner image |
| Status Message | Custom text |
| Pronouns | Optional |
| Website | Optional URL |
| Social Links | Up to 5 external links |
| Time Zone | IANA timezone string |
| Location | Optional, user-provided |
| Badges | System-assigned (e.g. Early Adopter, Partner) |

### 9.2 Friend System

**Actions:**
- Send friend request
- Accept / decline request
- Remove friend
- Block / unblock user

**Features:**
- Mutual friends display
- Friend suggestions (based on mutual communities)
- Friend activity feed (optional, user-controlled)

### 9.3 Direct Messaging

**Types:**
- One-to-one DMs
- Group DMs (up to 10 participants)

**Features:** Full message feature set (see Section 12), plus:
- Voice notes
- Polls
- Pinned messages
- Mentions

---

## 10. Community System

Communities are the equivalent of Discord servers — the top-level container for channels, members, and roles.

### 10.1 Community Types

| Type | Description |
|---|---|
| Public | Discoverable, joinable by anyone |
| Private | Invite-only, not discoverable |
| Invite-Only | Discoverable but requires invite to join |

### 10.2 Community Features

- Welcome screens with custom rules
- Verification system (email, phone, manual)
- Community rules (displayed on join)
- Discovery listing with tags and descriptions
- Community analytics dashboard
- Insights (growth, engagement, top channels)
- Custom invite links with expiry and usage limits

---

## 11. Channel System

| Channel Type | Description |
|---|---|
| Text Channel | Standard messaging channel |
| Voice Channel | Audio communication |
| Video Channel | Video + audio communication |
| Forum Channel | Threaded discussion, Reddit-style |
| Announcement Channel | Read-only for members, community news |
| Stage Channel | Broadcast with audience (like Twitter Spaces) |
| Thread Channel | Temporary sub-channels from messages |

All channels support:
- Per-channel permission overrides
- Slow mode (rate limiting per user)
- NSFW flagging
- Archive and delete
- Pinned messages

---

## 12. Messaging System

### 12.1 Supported Content Types

- Plain text
- Markdown-formatted text
- Images (inline preview)
- GIFs (via Tenor/Giphy integration)
- Videos (inline player)
- Audio files and voice notes
- Documents (PDF, DOCX, etc.)
- Polls
- Stickers
- Embeds (rich link previews, OG tags)

### 12.2 Rich Text Formatting

| Format | Syntax |
|---|---|
| **Bold** | `**text**` |
| *Italic* | `*text*` |
| __Underline__ | `__text__` |
| ~~Strikethrough~~ | `~~text~~` |
| \|\|Spoiler\|\| | `||text||` |
| `Inline code` | `` `code` `` |
| Code block | ` ```lang ``` ` with syntax highlighting |
| Blockquote | `> text` |
| Hyperlink | Auto-detected + manual Markdown links |

### 12.3 Message Actions

- Edit (with edit history)
- Delete (soft delete, message replaced with tombstone)
- Pin to channel
- Quote reply
- Start thread
- Save to bookmarks
- Copy message link
- Forward to another channel or DM
- Translate (AI-powered)
- Search within conversation

### 12.4 Reactions

- Standard Unicode emoji
- Custom community emoji
- Animated custom emoji
- Real-time reaction count updates
- Reaction picker with search

---

## 13. Voice & Video

### 13.1 Voice Channels

**Transport:** WebRTC  
**Signaling:** Custom Rust signaling server  
**Media:** SFU (Selective Forwarding Unit) for group calls — recommended: mediasoup or ion-sfu

**Features:**
- Join / leave channel
- Mute / deafen self
- Push-to-talk mode
- Noise suppression (client-side, e.g. RNNoise)
- Echo cancellation (WebRTC built-in)
- Audio leveling
- Speaking indicator
- Server-side mute (moderator action)
- Voice activity detection
- Spatial audio (Phase 3+)

### 13.2 Video Channels

**Features:**
- Webcam video up to 1080p
- Virtual background support
- Background blur (client-side ML)
- Camera switching (front/back on mobile)
- Multi-user video grid layout
- Video mute

### 13.3 Screen Sharing

| Quality | Resolution |
|---|---|
| Standard | 720p |
| HD | 1080p |
| QHD | 1440p |
| 4K | 2160p (hardware dependent) |

**Sharing options:**
- Full monitor
- Specific application window
- Browser tab

### 13.4 Performance Targets

| Metric | Target |
|---|---|
| Voice latency | < 150ms |
| Video latency | < 300ms |
| Audio quality | Opus codec, 48kHz |

---

## 14. Permissions & Roles

### 14.1 Role System

- Unlimited roles per community
- Colored roles
- Role icons (custom image or emoji)
- Role hierarchy (higher position = more authority)
- Role inheritance (not cascading, positional)

### 14.2 Permission Flags (150+)

**Channel permissions (per-channel overrides supported):**
- View channel
- Send messages
- Send messages in threads
- Create threads
- Embed links
- Attach files
- Add reactions
- Use external emoji
- Mention roles
- Manage messages
- Manage threads

**Community permissions:**
- Create invites
- Change nickname
- Manage nicknames
- Kick members
- Ban members
- Timeout members
- View audit log
- Manage channels
- Manage roles
- Manage community
- Administrator (bypasses all)

**Voice permissions:**
- Connect to voice
- Speak
- Video
- Priority speaker
- Mute members
- Deafen members
- Move members

---

## 15. Moderation System

### 15.1 Manual Actions

| Action | Description |
|---|---|
| Warn | Issue formal warning with reason |
| Timeout | Temporarily restrict messaging (up to 28 days) |
| Mute | Remove speak permission in voice |
| Kick | Remove from community (can rejoin) |
| Soft Ban | Ban then immediately unban (clears recent messages) |
| Ban | Permanent removal and IP block |

### 15.2 AutoMod

Automated detection and action on:
- Spam (repeated messages, flood)
- Scam links (known phishing domains)
- Mass mentions (@everyone abuse)
- Toxicity / hate speech (ML classifier)
- Harassment patterns
- NSFW content (image classifier)

AutoMod actions: delete message, warn, timeout, flag for human review.

### 15.3 Audit Logs

All moderation and administrative actions are permanently logged:
- Role changes
- Channel modifications
- Community setting changes
- User moderation actions
- Permission changes
- Invite creation / deletion
- Bot additions / removals

---

## 16. Notifications

### 16.1 Delivery Channels

| Channel | Provider |
|---|---|
| Push (mobile) | Firebase Cloud Messaging (FCM) |
| Push (desktop) | OS native via Tauri |
| Email | SendGrid / Postmark |
| In-app | WebSocket event |

### 16.2 Notification Events

- Direct mentions (`@username`)
- Role mentions (`@role`)
- `@everyone` / `@here` pings
- DM messages
- Friend requests
- Community invites
- Moderation actions on the user
- System alerts

### 16.3 Notification Settings

Per-community and per-channel notification preferences:
- All messages
- Only mentions
- Nothing

---

## 17. Search

### 17.1 Search Scope

| Scope | Powered By |
|---|---|
| Messages | OpenSearch |
| Users | OpenSearch + PostgreSQL |
| Communities | OpenSearch |
| Channels | PostgreSQL |
| Files | OpenSearch |

### 17.2 Search Filters

- Date range
- Author
- Channel
- Media type (image, video, file, link)
- Has attachment
- Pinned messages only

---

## 18. File Sharing

### 18.1 Supported Formats

- Images: PNG, JPG, GIF, WebP, HEIC
- Video: MP4, MOV, WebM
- Audio: MP3, OGG, WAV, FLAC, M4A
- Documents: PDF, DOCX, XLSX, PPTX
- Archives: ZIP, RAR, 7z
- Code files: All common extensions

### 18.2 Processing Pipeline

1. Presigned URL issued to client (avoids routing large files through backend)
2. Direct upload to R2/MinIO
3. Background job triggered: virus scan → metadata extraction → thumbnail generation
4. CDN-cached URL returned

### 18.3 Limits (configurable)

| Tier | Upload Limit |
|---|---|
| Free | 8 MB per file |
| Premium | 100 MB per file |
| Enterprise | 1 GB per file |

---

## 19. Social Features

### 19.1 Reactions & Polls

**Polls:**
- Single-choice and multi-choice
- Anonymous voting option
- Scheduled close date
- Live result updates

### 19.2 Stickers

- Global default packs
- Community-specific sticker packs
- Animated sticker support (Lottie / APNG)

### 19.3 Events

- Scheduled events in communities
- Voice / video / external location types
- RSVP system with attendee list
- Calendar integration (iCal export)
- Event reminders via notification system

---

## 20. Bot & Developer Platform

### 20.1 Bot Accounts

- First-class account type, clearly labeled in UI
- Scoped OAuth tokens (bots request specific permissions)
- Bot portal for registration, credential management, logs

### 20.2 Interaction Types

- Slash commands (`/command`)
- Context menu commands
- Message components (buttons, select menus)
- Modals / forms
- Webhooks (POST to community channel)
- Event subscriptions (message created, member joined, etc.)

### 20.3 API Surface for Developers

| API | Description |
|---|---|
| REST API | Standard resource CRUD |
| GraphQL API | Flexible query interface |
| WebSocket Gateway | Real-time event streaming |

### 20.4 SDKs

| Language | Priority |
|---|---|
| JavaScript / TypeScript | P0 |
| Python | P0 |
| Rust | P1 |
| Go | P1 |

---

## 21. AI Features

| Feature | Description |
|---|---|
| Message Summaries | TL;DR for long threads or channels |
| Conversation Summaries | Catch up after being away |
| Translation | Auto-translate messages to user's language |
| Voice Transcription | Real-time + post-call transcripts |
| Smart Moderation | AI-assisted content moderation |
| Search Assistant | Natural language search queries |

AI features must be:
- Opt-in per user and per community
- Clear in indicating when AI is involved
- Compliant with applicable privacy regulations

---

## 22. Security & Privacy

### 22.1 Security Features

- Multi-Factor Authentication (MFA) via Clerk
- Passkey (WebAuthn) support via Clerk
- Device verification for new logins
- Session management (view and revoke active sessions)
- Login history with IP and device info
- Security alerts (new device, password change, etc.)

### 22.2 Privacy Features

- Full data export (GDPR Article 20)
- Account deletion with data purge
- Granular privacy controls (who can DM, find, friend)
- Session revocation
- Message deletion with permanent purge option

### 22.3 Transport Security

- TLS 1.3 on all connections
- WebSocket over WSS only
- Signed URLs for all file access (no public-read buckets)
- Rate limiting on all endpoints

---

## 23. Performance Goals

| Metric | Target |
|---|---|
| Message delivery (P99) | < 100ms |
| Presence update propagation | < 500ms |
| Typing indicator propagation | < 100ms |
| Voice latency | < 150ms |
| Video latency | < 300ms |
| API response time (P95) | < 200ms |
| Search query response | < 500ms |
| File upload throughput | Limited by client bandwidth |

---

## 24. Firebase Policy

NosChatV3 has a strict and intentional policy on Firebase usage.

### 24.1 Permitted Firebase Services

| Service | Use |
|---|---|
| Firebase Cloud Messaging (FCM) | Push notifications to Android/iOS/Web |
| Firebase Crashlytics | Crash reporting and diagnostics |
| Firebase Analytics | Optional, opt-in usage analytics |

### 24.2 Forbidden Firebase Services

| Service | Reason |
|---|---|
| Firebase Authentication | Replaced entirely by Clerk |
| Cloud Firestore | Replaced by PostgreSQL |
| Firebase Realtime Database | Replaced by PostgreSQL + Redis |
| Firebase Hosting | Not required |
| Firebase Storage | Replaced by Cloudflare R2 / MinIO |

**NosChatV3 must not depend on Firebase for any core functionality.** FCM is treated as a notification delivery transport only, not a core data or auth system.

---

## 25. Phased Development Plan

### Phase 1 — Core Platform (MVP)

- [ ] Clerk authentication integration
- [ ] User profiles and presence
- [ ] Community creation and management
- [ ] Channel CRUD (text channels first)
- [ ] Real-time messaging (WebSocket + Redis)
- [ ] Typing indicators
- [ ] Basic role and permissions system
- [ ] File uploads (images and documents)
- [ ] Web client (Flutter Web)

### Phase 2 — Communication Layer

- [ ] Voice channels (WebRTC + SFU)
- [ ] Video channels
- [ ] Screen sharing
- [ ] OpenSearch integration (message search)
- [ ] Push notifications (FCM + desktop)
- [ ] Email notifications
- [ ] Mobile apps (Android + iOS)
- [ ] Desktop apps (Tauri, Windows/macOS)

### Phase 3 — Ecosystem

- [ ] Bot platform (accounts, slash commands, webhooks)
- [ ] Developer REST & GraphQL APIs
- [ ] SDK (JS/TS + Python)
- [ ] Events system
- [ ] AI features (summaries, translation, transcription)
- [ ] Forum channels
- [ ] Stage channels
- [ ] Community discovery and listings

### Phase 4 — Scale & Enterprise

- [ ] Enterprise workspace features (SSO, compliance)
- [ ] Advanced analytics (ClickHouse dashboards)
- [ ] Global infrastructure (multi-region)
- [ ] Community discovery ecosystem
- [ ] QUIC/HTTP3 transport
- [ ] Spatial audio
- [ ] LinkedIn and TikTok OAuth
- [ ] Advanced AI moderation

---

## 26. Architectural Decisions Log

| # | Decision | Rationale |
|---|---|---|
| ADR-001 | Rust + Axum for backend | Memory safety, async performance, zero-cost abstractions |
| ADR-002 | Flutter for all frontend | Single codebase across mobile, web, desktop |
| ADR-003 | Clerk for authentication | Complete auth solution; avoids building auth infrastructure |
| ADR-004 | PostgreSQL as source of truth | ACID compliance, mature ecosystem, horizontal read scaling |
| ADR-005 | Redis for real-time | Sub-ms pub/sub, perfect for ephemeral presence and typing |
| ADR-006 | No Firebase for data | Vendor lock-in risk, cost at scale, ownership concerns |
| ADR-007 | FCM allowed for push only | No viable self-hosted alternative for mobile push at scale |
| ADR-008 | WebRTC for voice/video | Open standard, low latency, peer-to-peer capable |
| ADR-009 | Cloudflare R2 for storage | S3-compatible, zero egress fees, global CDN |
| ADR-010 | Tauri v2 for desktop shell | Lighter than Electron, Rust-native, security-first |

---

*This document is the authoritative specification for NosChatV3. All engineering decisions must align with the principles and constraints defined here. When in doubt, prefer simplicity, ownership, and real-time performance.*
