# CLAUDE.md — NosChatV3 Project Context & Session Protocol

> **This file is the single source of truth for project state.** Read this entire file before doing anything else in a session. It should always reflect reality — if it's out of date, that's a bug, fix it as part of your work.

---

## 0. How to Use This File (read this first, every session)

1. **On session start:** Read this whole file top to bottom before writing any code or making any changes. Do not ask the user "what were we working on" — it's answered in Section 3 (Current Status) and Section 4 (Next Steps).
2. **Check the spec:** The real spec turned up in Session 5 as `NosChatV3_Master_Spec-v1-PREPIVOT.md` (root of repo) — but it's the **pre-pivot v1.0 spec** (Flutter + Clerk + Firebase + Cloudflare R2), not the reworked v2 described in Section 1's Session 1 history. The reworked `NosChatV3-Spec-v2.md` was apparently never actually saved to disk. Treat the PREPIVOT file as historical/superseded except where the user has explicitly un-pivoted a specific piece (see Section 5 — Clerk is back in as of Session 5, the rest of the pivot away from Firebase/Flutter/R2 still stands).
3. **During the session:** After completing any meaningful step (a feature, a fix, a config change, a decision made with the user, a blocker hit), update this file immediately — don't wait until the end of the session. Meaningful = anything the next session needs to know to not repeat work or re-ask a question.
4. **Update discipline:**
   - Update **Section 3 (Current Status)** so it always reflects the true current state.
   - Append a dated entry to **Section 6 (Session Log)** — never delete old entries, this is an append-only history.
   - Update **Section 4 (Next Steps)** so the next session (or the next step in this one) has a clear, concrete pickup point — not "continue working on backend," but the actual next action.
   - If a decision was made that changes or adds to the spec, note it in **Section 5 (Decisions & Deviations Log)**.
5. **On session end (or when the user says they're stepping away):** Do one final pass over Sections 3 and 4 to make sure they're accurate, even if nothing "big" happened.
6. **Never mark something done in Section 3 unless it actually is** — verified working, not just written. If it's written but untested, say so explicitly.

---

## 1. Project Summary

**NosChatV3** — a Discord/Slack-style real-time communication, community, and social platform.

**Architecture (current, post-Session-5 hybrid — see Section 5 for the Clerk decision):**
- Frontend: Next.js (React/TS), deployed to Vercel
- Backend: Rust + Axum, self-hosted in Docker on the user's homelab
- Database: PostgreSQL, self-hosted on homelab
- Cache/pub-sub: Redis/Valkey, self-hosted on homelab
- Search: OpenSearch, self-hosted on homelab
- File storage: MinIO, self-hosted on homelab
- **Auth: Clerk** (sign-in/sign-up UI + credential storage + session issuance) — **everything else stays self-hosted.** The Rust backend verifies Clerk-issued JWTs (RS256, via Clerk's JWKS) on protected routes and keeps a local `users` row per Clerk user via a `/webhooks/clerk` sync endpoint (Svix-signed). This backend no longer stores passwords or issues its own sessions.
- Voice/video: WebRTC + self-hosted mediasoup SFU + coturn
- Push notifications: Web Push (VAPID), no Firebase
- Domain: custom domain connects Vercel frontend to homelab backend via reverse proxy (Caddy/Traefik) + Cloudflare Tunnel or DDNS

**Explicitly forbidden in this project:** Firebase (any service), Auth0, Supabase, any managed cloud database, any managed object storage as the primary store. **Clerk is now explicitly allowed, scoped to auth only** (see Section 5) — this reverses the earlier blanket "no Clerk" rule from Sessions 1–4.

**Repo structure decision:** Monorepo — `frontend/` (Next.js) and `backend/` (Rust/Axum workspace) live side by side in this repo, confirmed with user.

---

## 2. Repo / Environment Facts

- **Repo location:** `NosChatV3/` (local git repo, branch `main` — see Section 3 for commit history)
- **Repo structure:** Monorepo — `frontend/`, `backend/`, `docker-compose.yml` at root
- **Repo remote:** none configured yet — repo exists only on this local machine
- **Homelab access:** not yet documented — note IP/hostname conventions, Docker host details, how to reach it once set up
- **Domain name in use:** not yet provided by user
- **Vercel project:** not yet created
- **Clerk project:** **real project exists as of Session 7** — application name `NosChatV3`, `app_3Hszb1yDkfXYVHLtw2LiK8qBoIg`, development instance `ins_3Hszb2l5z0qGTjIUEuvwxMLr9E9`, frontend API domain `merry-krill-77.clerk.accounts.dev`. Owner account: `dekanprints@gmail.com`. Production instance not configured yet (dev only).
- **Local dev — how to run:**
  - Frontend: `cd frontend && npm run dev` (Next.js dev server, pinned to **port 3100** — see quirk below). `frontend/.env.local` now has real Clerk dev keys (written by `clerk init` in Session 7) — sign-in/sign-up actually work.
  - Backend: `cd backend && cargo run --bin auth-service` (binds `0.0.0.0:4000`). Runs pending `sqlx` migrations automatically on startup. Exposes `GET /health`, `GET /me` (Clerk-JWT-protected), `POST /webhooks/clerk`. `backend/auth-service/.env` now has a real `CLERK_JWKS_URL` (Session 7); `CLERK_WEBHOOK_SECRET` is still the placeholder, so `/webhooks/clerk` still fails closed (500) until a real webhook endpoint/relay is set up (see Section 4, Step 3).
  - Local DB/cache: `docker compose up -d` from repo root (Postgres on host port **5433**, Redis on 6379)
- **⚠️ MACHINE-SPECIFIC QUIRK #1 — dev Postgres runs on port 5433, NOT 5432:** pre-existing native Windows PostgreSQL service on 5432 (unrelated to this project) silently intercepts connections meant for the Docker container, producing a misleading "password authentication failed" error with zero connection attempts in the container's own logs. Fix already applied: container mapped to 5433, `DATABASE_URL` defaults updated to match. **If this resurfaces, check `netstat -ano | findstr :5432` before assuming credentials are wrong.**
- **⚠️ MACHINE-SPECIFIC QUIRK #2 — frontend dev server pinned to port 3100, NOT 3000:** a system-wide `PORT=4100` env var on this machine overrides Next.js's default port. Fix already applied: `-p 3100` explicit in `package.json` scripts.
- **Local toolchain verified present:** Node v24.11.0, npm 11.17.0, rustc 1.94.0, cargo 1.94.0, Docker 29.6.2, git 2.51.2, sqlx-cli (at `~/.cargo/bin/sqlx.exe`), Clerk CLI 3.1.0 (installed Session 7 via `npm install -g clerk`)
- **⚠️ ENVIRONMENT NOTE — axum pinned to 0.8, not 0.7:** Session 5 hit a real `E0195` lifetime-mismatch compile error implementing a custom `FromRequestParts` extractor (`ClerkUser` in `clerk.rs`) against axum 0.7.9 + rustc 1.94 — the manual async-fn-in-trait impl didn't satisfy the trait's RPITIT lifetime capture rules on this rustc version. **Fix: bumped `axum` 0.7→0.8 and `axum-extra` 0.9→0.10 workspace-wide**, which resolved it cleanly with no other code changes needed. If a fresh session ever hits `E0195` on a custom extractor again, check the axum version first before assuming the extractor code itself is wrong.
- **⚠️ ENVIRONMENT NOTE — frontend proxy file is `src/proxy.ts`, not `src/middleware.ts` (Session 6):** Next.js 16 renamed the middleware convention to `proxy.ts` — `@clerk/nextjs` 7.7.5's `clerkMiddleware()` works identically under the new filename, no API changes needed, just the rename. `middleware.ts` is deleted; don't recreate it.
- **⚠️ ENVIRONMENT NOTE — `createRouteMatcher` is deprecated (surfaced Session 7):** running the real dev server for the first time (previously only build-tested) surfaced a runtime warning that didn't show up in `npm run build`: `createRouteMatcher` is deprecated in favor of resource-based `auth.protect()` checks placed in each page/route instead of path-matching in `proxy.ts`. Not fixed yet — `src/proxy.ts` still uses it and it still works, just flagged as deprecated. Worth migrating later; see Clerk's migration guide linked in the warning text. Low priority since it's non-blocking.
- **⚠️ TOOLING NOTE — Clerk CLI's `clerk init -y` installs "agent skills" globally, not just Clerk into this project (Session 7):** running `clerk init` with `-y` (to skip prompts) also silently accepted a separate, unrelated prompt to install 8 "Clerk agent skill" packages to `~/.agents/skills`, symlinked across many AI coding tools system-wide (Claude Code, Cursor, Copilot, etc.), not scoped to this repo. Most of the 8 failed to actually install ("PromptScript does not support global skill installation"); the ones that succeeded are outside repo scope. One (`clerk-backend-api`) was flagged "High Risk" by Snyk in the CLI's own output. **Use `clerk init --no-skills` in future sessions/projects to avoid this.** Not cleaned up as of end of Session 7 — user was informed and chose to keep moving rather than clean up immediately; revisit if it causes issues.
- **Secrets / env vars:**
  - `backend/auth-service/.env.example` — `DATABASE_URL`, `REDIS_URL`, `CLERK_JWKS_URL`, `CLERK_WEBHOOK_SECRET`. (The old `JWT_SECRET` var is gone — this service no longer issues its own JWTs.)
  - `backend/auth-service/.env` — **real file now exists** (Session 7, gitignored, confirmed via `git check-ignore`). Real `DATABASE_URL`/`REDIS_URL` (unchanged from Session 3's port-5433 fix), real `CLERK_JWKS_URL` (`https://merry-krill-77.clerk.accounts.dev/.well-known/jwks.json`, confirmed live), placeholder `CLERK_WEBHOOK_SECRET=whsec_changeme` (intentionally not yet real — see Section 4, Step 3).
  - `frontend/.env.local.example` — `NEXT_PUBLIC_AUTH_SERVICE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`.
  - `frontend/.env.local` — **real file now exists** (written directly by `clerk init` in Session 7, gitignored, confirmed via `git check-ignore`). Contains real dev `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY`. Never read or printed directly by the agent — Clerk's own tooling wrote it.

---

## 3. Current Status

**Phase:** Auth has been migrated from self-hosted Argon2id/JWT to Clerk, and **a real Clerk project now exists and is wired up on both sides.** Frontend and backend have both been runtime-verified against the real live Clerk dev instance (JWKS fetch confirmed, real keys loaded). **What has NOT yet been verified end-to-end is an actual human completing sign-up through the UI and the webhook sync firing** — that's the immediate next step, and needs the user directly.

**What exists and is VERIFIED working (actually run, not just written):**
- `frontend/` — `npm run build` succeeds cleanly. Routes: `/` (dashboard, Clerk-gated), `/login/[[...rest]]`, `/register/[[...rest]]` (Clerk's `<SignIn>`/`<SignUp>` components, dark-theme styled). `src/proxy.ts` gates everything except `/login`/`/register`. **Session 7: ran `npm run dev` with real Clerk dev keys (via `.env.local`, confirmed in dev server startup log as `Environments: .env.local`) and confirmed `GET /login` returns a real `200`** — this is the first time the frontend has rendered Clerk's actual sign-in UI against a live instance, not a placeholder key.
- `backend/auth-service` — `cargo build` succeeds cleanly, zero warnings. **Session 7: ran with a real `CLERK_JWKS_URL` for the first time:**
  - `GET /health` → `{"db":true,...}` confirmed live.
  - `GET /me` with no token → `401`. With a garbage bearer token → `401` — now correctly fails closed against **real** Clerk verification logic (JWKS fetch succeeds), not just "unconfigured, fails closed by default" as in Session 5.
  - Independently confirmed `https://merry-krill-77.clerk.accounts.dev/.well-known/jwks.json` is reachable and returns a real RSA key whose `kid` (`ins_3Hszb2l5z0qGTjIUEuvwxMLr9E9`) matches the instance ID from `clerk apps list` — the JWKS plumbing is provably correct, independent of the backend code.
  - `POST /webhooks/clerk` still fails closed with `500` — `CLERK_WEBHOOK_SECRET` is still a placeholder on purpose (see below).
- `users` table migrated (`0002_clerk_auth.sql`, applied): `clerk_user_id TEXT UNIQUE NOT NULL`, relaxed `password_hash`/`username` constraints. Confirmed via `psql \d users` (Session 5).
- `docker-compose.yml` — Postgres 16 (5433) + Redis 7 (6379), both `Up (healthy)` as of Session 7.
- **Real Clerk project exists** (`app_3Hszb1yDkfXYVHLtw2LiK8qBoIg`, name `NosChatV3`) — confirmed genuinely linked via `clerk apps list` showing the name matches, not just trusting the ID blindly. `clerk doctor` reports all green except "production not configured" (expected, dev-only for now).
- Session 5's entire uncommitted Clerk migration plus Session 6's `proxy.ts` fix were committed together in Session 6 as `b8c2519`.

**What does NOT exist yet:**
- **No human has actually signed up a test user yet.** Frontend/backend are both provably wired to real Clerk, but nobody has clicked through `<SignUp>` at `http://localhost:3100/register` yet. This is the very next step and needs the user directly — an agent can verify plumbing but can't click through a live browser UI.
- **No real webhook secret / endpoint.** `CLERK_WEBHOOK_SECRET` is still `whsec_changeme` on purpose — a real one needs either a dashboard-configured webhook endpoint (requires a public URL, i.e. a tunnel) or the Clerk CLI's `clerk webhooks listen --forward-to <url>` local relay (discovered in Session 7, not yet used — looks like it could replace needing ngrok entirely, but hasn't been tried). Until this is real, `/webhooks/clerk` will keep returning `500` and the `users` table will NOT get synced automatically on sign-up.
- No TOTP, no WebAuthn wired into the `<SignIn>`/`<SignUp>` component config yet (Clerk defaults as-is).
- No repo remote (GitHub/GitLab/self-hosted Git) — repo is still local-only.
- No homelab Docker stack, no domain/DNS/reverse proxy config, no Vercel project, no production Clerk instance.
- The pre-pivot spec file still needs a real line-by-line reconciliation pass (unchanged since Session 5).
- `createRouteMatcher` deprecation in `proxy.ts` not yet migrated (see Section 2 note) — non-blocking.
- The global "agent skills" install side effect from `clerk init -y` (see Section 2 note) not cleaned up — user was informed, chose to defer.

**Active blockers:**
- **None that block basic sign-up/sign-in testing right now** — frontend and backend are both live and correctly configured for that. The remaining blocker is specifically for the **webhook sync loop**: no real `CLERK_WEBHOOK_SECRET` yet, so a user signing up will authenticate fine but won't get a row created in the local `users` table until the webhook is wired up (Section 4, Step 3).
- Dev servers were left running in the background at the end of Session 7 (see Session Log) — logs at `NosChatV3/auth-service.log` and `NosChatV3/frontend-dev.log` if a future session needs to check on them or should kill and restart them.

---

## 4. Next Steps (concrete pickup point)

1. ~~Create a real Clerk project~~ — **done in Session 7.** Real keys are live in both `.env` files.
2. **Sign up a real test user through `<SignUp>` at `http://localhost:3100/register`** (both dev servers are already running as of end of Session 7 — check `auth-service.log`/`frontend-dev.log` or just re-run `cargo run --bin auth-service` / `npm run dev` if they've been killed since). Confirm the sign-up completes and Clerk issues a session. **Note: the webhook sync will NOT fire yet** (see Step 3) — expect the dashboard's `GET /me` call to fail or return an unsynced state until that's wired up. This step just proves the Clerk auth UI itself works live; the full loop needs Step 3 too.
3. **Wire up the webhook so `/webhooks/clerk` actually syncs users.** Two options surfaced in Session 7, neither tried yet:
   - Traditional: configure a real webhook endpoint in the Clerk dashboard pointing at this backend, which requires a public URL — needs a tunnel tool (ngrok or similar). Not yet decided which tool; ask the user.
   - **Possibly better: the Clerk CLI has a native `clerk webhooks listen --forward-to <url>` command** that streams/forwards webhook deliveries to a local handler without needing a public tunnel at all. Discovered via `clerk webhooks --help` in Session 7 but not yet tested — worth trying this first before reaching for ngrok, since it'd avoid an extra dependency. Unclear yet exactly how the signing secret is derived/retrieved for this path — investigate `clerk webhooks token` and `clerk webhooks verify` before assuming the flow.
4. ~~Migrate `middleware.ts` to `proxy.ts`~~ — **done in Session 6.**
5. Set up a remote for the repo — confirm GitHub vs. GitLab vs. self-hosted with the user before defaulting.
6. TOTP/WebAuthn, homelab Docker stack, domain/DNS/reverse proxy, Vercel project, production Clerk instance all come after the Clerk loop above is fully verified live — don't jump ahead.
7. Lower priority, non-blocking: migrate `createRouteMatcher` in `proxy.ts` to Clerk's newer resource-based `auth.protect()` pattern per the deprecation warning (Section 2). Decide whether to clean up the global `~/.agents/skills` install from `clerk init -y` (Section 2) — user was informed, hasn't asked for cleanup yet.

**Immediate next action if resuming right now:** Step 2 — get a human to actually sign up at `/register` and see what happens. If the dev servers aren't running anymore, restart them first (`docker compose up -d` if needed, then `cargo run --bin auth-service` in `backend/`, then `npm run dev` in `frontend/`).

---

## 5. Decisions & Deviations Log

*(Anything decided that adds to, changes, or deviates from the spec — so it's not lost or re-litigated. Most recent first.)*

- **Session 7 — user confirmed `app_3Hszb1yDkfXYVHLtw2LiK8qBoIg` (referenced in a pasted Clerk-CLI setup doc) is genuinely their real Clerk app for this project**, before any `clerk init`/`clerk auth login` commands were run against it. The agent had flagged this explicitly first rather than assuming a pre-filled app ID in a pasted document was trustworthy — this was treated as a real trust decision requiring explicit user sign-off, consistent with how Section 4/Step 1 had always been described as "requires the user directly." Independently corroborated after the fact via `clerk apps list`, which showed the app's actual name is `NosChatV3`, matching.
- **Session 7 — installed the Clerk CLI globally (`npm install -g clerk`) and used it (`clerk init --app app_3Hszb1yDkfXYVHLtw2LiK8qBoIg -y`) to link the real Clerk app and write real dev keys into `frontend/.env.local`.** This is the first time real Clerk credentials have existed anywhere in this project. Not a spec-level decision — this is exactly what Section 4 Step 1 always called for, just finally unblocked.
- **Session 7 — derived the backend's `CLERK_JWKS_URL` from the publishable key rather than asking the user for it directly**, since publishable keys are non-secret and their base64 payload directly encodes the frontend API domain (`pk_test_bWVycnkta3JpbGwtNzcuY2xlcmsuYWNjb3VudHMuZGV2JA` → `merry-krill-77.clerk.accounts.dev`). Independently confirmed by curling the resulting URL and checking the returned key's `kid` against the instance ID from `clerk apps list` — didn't just trust the decode, verified it resolves to something real and matching. Left `CLERK_WEBHOOK_SECRET` as a placeholder on purpose, since that one has no equivalent safe-to-derive value — it requires an actual endpoint registration step (see Section 4, Step 3).
- **Session 6 — migrated `middleware.ts` → `src/proxy.ts`** per Next.js 16's renamed convention. Confirmed via Clerk's own docs that `clerkMiddleware()` works identically under the new filename (no API changes, pure rename), and via web search that this is the officially supported migration path, not a workaround. `npm run build` verified clean afterward with no deprecation warning and correct `ƒ Proxy (Middleware)` build output. Not a spec-level decision — routine toolchain upkeep.
- **Session 5 — user explicitly reversed the earlier "no Clerk" decision**, scoped specifically to auth: *"I want you to use clerk for signin/signup but keep everything else local except the authentication."* Implemented as: Clerk owns sign-in/sign-up UI, credential storage, and session JWT issuance; Postgres/Redis/Next.js/the Rust backend all stay exactly as self-hosted as before. The backend's role shifted from issuing its own auth to **verifying Clerk's** — JWKS-based RS256 verification on protected routes, plus a `/webhooks/clerk` endpoint (Svix-signature-verified) to keep a local `users` row per Clerk user. This is a narrower reversal than it might look — Firebase, Auth0, Supabase, and managed DB/object storage are all still explicitly forbidden (Section 1); only Clerk, and only for auth, is now allowed.
- **Session 5 — found `NosChatV3_Master_Spec-v1-PREPIVOT.md` in the user's Downloads folder** (not the repo) and copied it in, but it turned out to be the **original pre-pivot v1.0 spec** (Flutter/Clerk/Firebase/R2), not the reworked v2 the user had been asking about since Session 1. Renamed it honestly on copy-in (`-PREPIVOT` suffix) rather than letting it masquerade as the authoritative spec. The "real" v2 spec apparently was never actually saved to disk despite Session 1's log claiming it was produced — flagged to the user rather than guessed around.
- **Session 5 — bumped axum 0.7→0.8 / axum-extra 0.9→0.10 workspace-wide** to fix a genuine `E0195` compiler error implementing a custom Clerk-JWT `FromRequestParts` extractor against rustc 1.94. Not a spec-level decision, but a real toolchain compatibility fix worth remembering if it recurs.
- **Built the first auth schema and `/register`/`/login` routes as a best-guess standard design** (Sessions 1–4, now superseded by the Clerk migration above — kept here for history). Design: `users` table (id, email, username, password_hash via Argon2id, created_at) + an empty `webauthn_credentials` table stubbed for later, JWT issued on register/login.
- **Pinned the frontend dev server to port 3100** (via explicit `-p 3100` in `package.json` scripts) because a system-wide `PORT=4100` env var on this machine (unrelated to this project) was overriding Next.js's default and causing `EADDRINUSE`. Machine-specific workaround, not a spec-level decision.
- **Moved local dev Postgres from host port 5432 to 5433** in `docker-compose.yml` because this specific dev machine has a pre-existing native Windows Postgres service already on 5432. Machine-specific workaround, not a spec-level decision — harmless to keep even on a machine without the conflict.
- Confirmed monorepo structure (frontend + backend in one repo) with user.
- Pivoted away from Flutter/Clerk/Firebase/Cloudflare R2 (original v1.0 spec) to Next.js/self-hosted-auth/MinIO in Session 1, because the user's actual hosting plan (homelab backend+DB, Vercel frontend, custom domain, zero Firebase) required it. **Partially reversed in Session 5** (Clerk is back, scoped to auth only — see above); Flutter, Firebase, and Cloudflare R2 remain pivoted-away-from.

---

## 6. Session Log (append-only — newest entry at the bottom)

### Session 1
- Took the original v1.0 NosChatV3 spec (Flutter + Rust/Axum + Clerk + Firebase + Cloudflare R2 + managed cloud hosting) and reworked it for the user's actual plan: Postgres + backend self-hosted on homelab via Docker, frontend on Vercel, connected via custom domain, zero Firebase.
- Clarified with user: no Firebase at all, backend framework = "best for the app" → chose Rust + Axum, frontend framework = "best and looks best" → chose Next.js.
- Made an unprompted but necessary call: replaced Clerk (cloud auth) with self-hosted auth, since Clerk contradicts the "fully hosted locally" requirement. Flagged this clearly to the user.
- Claimed to have produced `NosChatV3-Spec-v2.md` — **note from Session 5: this file was never actually found on disk; only the pre-pivot v1.0 spec turned up.** Treat that claim with suspicion for anything not otherwise corroborated in this log.
- Created this file (`CLAUDE.md`) as the persistent session-continuity file.
- **No code written yet.** Next session should start at Section 4, Step 1.

### Session 2
- Verified local toolchain: Node, npm, rustc, cargo, Docker, git — all present.
- Confirmed with user: **monorepo** structure, new folder **NosChatV3**.
- Created `NosChatV3/` folder, ran `git init` (branch `main`).
- Scaffolded `frontend/` via `create-next-app` (TypeScript, Tailwind, App Router, ESLint, `src/` dir, `@/*` alias) and initialized shadcn/ui. **Verified `npm run build` succeeds.** Fixed a Turbopack root-detection warning by pinning `turbopack.root` in `next.config.ts`.
- Scaffolded `backend/` as a Cargo workspace with `auth-service` as the first member. Wrote a minimal Axum server with a `/health` endpoint that reports DB connectivity without crashing if Postgres is unreachable. **Verified `cargo build` succeeds**, and verified by actually running the binary and curling `/health`.
- Wrote `docker-compose.yml` for local dev (Postgres 16 + Redis 7). **Attempted to run it — failed because Docker Desktop wasn't running on this machine.** Flagged as unverified rather than marked done.
- Wrote root `.gitignore`, `backend/auth-service/.env.example`.
- Made the initial commit (`778a913`, 30 files) to the local `main` branch.
- Carried this CLAUDE.md into the new repo root, flagged `NosChatV3-Spec-v2.md` as missing from the repo.
- Second commit: updated CLAUDE.md with accurate session-2 status.

### Session 3
- User confirmed Docker was now running. Ran `docker compose up -d` — both `noschat-postgres-dev` and `noschat-redis-dev` came up and reported `healthy`/`Up`.
- Ran `auth-service` against the now-live Postgres container — got `{"db":false,...}` unexpectedly (should have been `true`). Investigated:
  - Postgres container logs showed **zero connection attempts** at the times the Rust app tried to connect — meaning the connections weren't reaching the container at all, despite the error message being the classic "password authentication failed."
  - Wrote a throwaway Node.js (`pg` library) test script to check whether this was Rust/sqlx-specific — same failure, same message, confirming it was environmental, not a code bug.
  - Ran `netstat -ano | findstr :5432` and found **two different processes** bound to port 5432 on this machine: Docker's backend, and a pre-existing native Windows `postgres.exe` service unrelated to this project. Windows was routing new connections to the native service (with different real credentials), producing the misleading auth-failure message.
  - **Fix:** remapped the Docker Postgres container to host port **5433** in `docker-compose.yml`, updated `DATABASE_URL` defaults in `auth-service/src/main.rs` and `.env.example` to match. Recreated containers, reconfirmed connectivity, ran `auth-service` again.
  - **Confirmed `GET /health` now returns `{"db":true,"service":"auth-service","status":"ok"}`.**
  - Cleaned up: killed the test process, deleted throwaway test files.
- Documented the port-conflict quirk in Section 2 and the Decisions log.
- **Session ends here, local dev environment is fully working.**

### Session 4
- Spec file still not available. Proceeded with a best-guess standard auth schema/routes rather than blocking further, flagged clearly as provisional.
- Wrote and applied `0001_init_users.sql` — `users` and `webauthn_credentials` tables confirmed present via `psql \d`.
- Implemented `POST /register` and `POST /login` (Argon2id, JWT issuance). Verified live: register success, duplicate → `409`, wrong password → `401`, validation failure → `400`, correct login → `200`.
- Built `/login` and `/register` frontend pages, dark self-hosted theme, wired to the backend via `auth-api.ts`. `npm run build` passed clean.
- Hit and fixed a `PORT=4100` env var collision — pinned frontend dev server to port 3100.
- Verified live HTML rendering of `/login`, not just status codes.
- Fixed a leftover "Create Next App" default metadata title.
- Cleaned up leftover background processes and log files, committed as `e74ab82`.
- **Session ends here.**

### Session 5
- Resumed via a real MCP filesystem/shell connector — verified the actual on-disk repo state independently rather than trusting a pasted prior-session transcript at face value (the transcript claimed the "no Clerk" footer text had already been fixed; it hadn't been — corrected that assumption before doing anything else).
- Searched for the missing spec file, found `NosChatV3_Master_Spec-v1-PREPIVOT.md` in the user's Downloads folder — turned out to be the pre-pivot v1.0 spec, not the v2 rewrite. Flagged the discrepancy to the user rather than guessing which parts still applied.
- **User decision: use Clerk for sign-in/sign-up, keep everything else self-hosted.** See Section 5 for full rationale.
- **Frontend:** added `middleware.ts` (`clerkMiddleware`, gates everything except `/login`/`/register`), wired `ClerkProvider` into root layout with dark-theme `appearance` config (had to find the real `Variables`/`Elements` type definitions in `node_modules` by grep — several guessed property names, like `colorInputBackground`/`colorText`/`colorNeutral`, don't actually exist on the real type; the correct set is `colorForeground`, `colorMutedForeground`, `colorInput`, `colorInputForeground`, `colorBorder`, etc.). Replaced the custom `/login` and `/register` pages with Clerk's `<SignIn>`/`<SignUp>` components (catch-all `[[...rest]]` routes, as Clerk requires). Removed the now-dead `auth-api.ts` client; added `backend-api.ts` for calling the Rust backend with a Clerk session token. Rebuilt `/` as a minimal real dashboard (calls `GET /me` on the backend to prove the Clerk→backend loop) instead of the old unconditional redirect-to-login stub. Fixed the footer/metadata text that still said "no Clerk." **`npm run build` verified passing clean.**
- **Backend:** added `clerk.rs` (JWKS fetch+cache, RS256 JWT verification, `ClerkUser` axum extractor with automatic 401 on missing/invalid/expired tokens), `webhooks.rs` (`POST /webhooks/clerk`, Svix-signature-verified, handles `user.created`/`user.updated`/`user.deleted` by upserting/deleting the local `users` row), rewrote `routes.rs` (`GET /me` as the reference protected-route pattern), rewrote `main.rs` to wire it together and to **run pending `sqlx` migrations automatically on startup** (previously required a manual `sqlx migrate run`). Removed `auth.rs` (Argon2id + self-issued JWT) entirely.
- Wrote `0002_clerk_auth.sql`: adds `clerk_user_id TEXT UNIQUE NOT NULL`, drops `NOT NULL` on `password_hash`/`username`.
- **Hit and fixed a real toolchain issue:** a custom `FromRequestParts` extractor impl (`ClerkUser`) failed to compile against axum 0.7.9 + rustc 1.94 with `E0195` (lifetime mismatch in the async-fn-in-trait impl), even though the code matched axum-extra's own working extractor examples byte-for-byte. Root-caused to an axum/rustc version incompatibility, not a code bug — fixed by bumping `axum` 0.7→0.8 and `axum-extra` 0.9→0.10 workspace-wide. **Documented in Section 2** so a future session doesn't waste time re-debugging identical-looking "correct" code.
- **Verified live against the real local Postgres** (not just compiled): `cargo build` clean with zero warnings; started `auth-service`, confirmed `GET /health` → `{"db":true,...}`; confirmed migrations `0001` and `0002` both applied automatically via `_sqlx_migrations`; confirmed `psql \d users` shows the new `clerk_user_id` column and relaxed constraints; confirmed `GET /me` fails closed with `401` both with no token and with a garbage token; confirmed `POST /webhooks/clerk` fails closed with `500` when unconfigured (expected — no real webhook secret exists yet); confirmed unknown routes now return a real `404` via a fallback handler instead of axum's bare default. Killed the test process and deleted the throwaway `run.log` afterward.
- **What was NOT verified:** anything against a real Clerk project — no Clerk account/app has been created for NosChatV3 yet, so the actual sign-up → webhook → local sync → `/me` loop has never run end-to-end against live Clerk. This is explicitly flagged as the top blocker for next session (see Section 4).
- **Session ends here.** Next session starts at Section 4, Step 1: get real Clerk credentials into both `.env` files before anything else can be genuinely verified.

### Session 6
- Resumed via the real MCP filesystem/shell connector. Re-verified on-disk state against `CLAUDE.md`'s claims before acting (matched — Session 5's account of the repo held up this time).
- Checked Section 4's remaining steps for anything actionable without user input. Steps 1–3 and 5 all require the user directly (real Clerk credentials, a tunnel-tool choice, a git-remote choice) — did not attempt to guess around any of these. Step 4 (`middleware.ts` → `proxy.ts` migration) was the one concretely actionable item.
- Confirmed via Clerk's own docs (web search, since this is a Next.js 16 / Clerk 7.x-era change outside training data) that `clerkMiddleware()` needs no code changes for the rename — only the filename moves from `middleware.ts` to `src/proxy.ts`, with an additional `/__clerk/(.*)` matcher entry recommended.
- Renamed `frontend/src/middleware.ts` → `frontend/src/proxy.ts` (same `clerkMiddleware`/`createRouteMatcher` logic, added the `/__clerk/(.*)` matcher). Deleted the old file rather than leaving both around.
- **Verified via `npm run build`:** clean build, zero errors, zero deprecation warnings, output correctly shows `ƒ Proxy (Middleware)` instead of the old `Middleware` line — confirms Next.js is actually picking up the new file, not silently ignoring it.
- Did not touch anything backend-side or attempt Clerk-project creation, git remote setup, or the webhook tunnel — all of those are correctly blocked on user input per Section 4 and weren't worked around.
- Committed Session 5's entire previously-uncommitted Clerk migration plus this session's `proxy.ts` fix together as `b8c2519` (24 files), after confirming with the user first and cross-checking staged files against what `CLAUDE.md` claimed before committing.
- **Session ends here.** Next session still starts at Section 4, Step 1 — real Clerk credentials remain the hard blocker for all further end-to-end verification. No autonomous progress is possible on the auth loop until the user provides them.

### Session 7
- User pasted a Clerk-CLI agent setup script that referenced a specific, pre-filled Clerk application ID (`app_3Hszb1yDkfXYVHLtw2LiK8qBoIg`) to link the project to. **Did not run any commands against it before asking the user to explicitly confirm this was genuinely their app** — flagged that a hardcoded ID in a pasted document couldn't be trusted as automatically legitimate, since linking the real backend's auth verification to an unverified Clerk instance was exactly the kind of decision Section 4 had always said required the user directly. User confirmed. Proceeded only after that.
- Installed the Clerk CLI (`npm install -g clerk`, v3.1.0). Ran `clerk auth login` — first attempt's local OAuth callback listener died because the sandboxed command execution has a hard timeout and killed the process before the user finished the browser flow, causing a blank page. Recognized this as an infra/tooling limitation (not a Clerk problem) and re-ran with a longer timeout window; second attempt succeeded, logged in as `dekanprints@gmail.com`.
- Ran `clerk init --app app_3Hszb1yDkfXYVHLtw2LiK8qBoIg -y` from `frontend/`. Correctly **skipped** `src/proxy.ts` and `layout.tsx` (already had Clerk middleware/`ClerkProvider` from Sessions 5–6 — no double-setup). **Wrote real Clerk dev keys to `frontend/.env.local`** — the actual unblock Section 4 had been waiting on since Session 5.
- **Unexpected/unwanted side effect from `-y`:** `clerk init` also silently accepted a separate, unrelated prompt to install 8 "Clerk agent skill" packages globally to `~/.agents/skills`, symlinked across many AI coding tools system-wide, not scoped to this repo. Flagged this transparently to the user rather than treating it as a done deal — one package was flagged "High Risk" by Snyk in the CLI's own output. User acknowledged and asked to keep moving rather than clean up immediately; documented in Section 2 as an open item, and noted `--no-skills` as the fix for future `clerk init` runs.
- Verified the `/__clerk/(.*)` matcher already present in `src/proxy.ts` (added in Session 6) is functionally equivalent to Clerk's now-recommended `/__clerk/:path*` and correctly positioned — no change needed. Ran `clerk doctor`: all green except "production not configured" (expected).
- **Derived the backend's real `CLERK_JWKS_URL` from the publishable key** (`pk_test_bWVycnkta3JpbGwtNzcuY2xlcmsuYWNjb3VudHMuZGV2JA` decodes to `merry-krill-77.clerk.accounts.dev`) rather than reading secrets or guessing — publishable keys are non-secret. **Independently verified this was correct** by curling the resulting `.well-known/jwks.json` URL directly and confirming the returned key's `kid` matched the real instance ID from `clerk apps list`, not just trusting the base64 decode blindly. Wrote this into a new, real `backend/auth-service/.env` (confirmed gitignored via `git check-ignore`) alongside the unchanged DB/Redis settings from Session 3. Left `CLERK_WEBHOOK_SECRET` as the placeholder on purpose — no safe way to derive that one, it needs a real endpoint registration step.
- **Ran both services live against the real Clerk instance for the first time:** started `auth-service` in the background (logs at `NosChatV3/auth-service.log`), confirmed `GET /health` → `{"db":true,...}`, confirmed `GET /me` → `401` both with no token and a garbage token — now failing closed against **real** JWKS-based verification, not just "unconfigured, fails closed by default." Started the frontend dev server in the background (logs at `NosChatV3/frontend-dev.log`), confirmed `GET /login` → real `200` with real Clerk keys loaded (`Environments: .env.local` in the startup log). This is the first time either side of the stack has been runtime-verified against a live Clerk project rather than a placeholder/unconfigured state.
- **Surfaced a new, previously-unseen deprecation warning** in the frontend dev server's real runtime output (not present in `npm run build`, which doesn't hit this code path the same way): `createRouteMatcher` is deprecated in favor of resource-based `auth.protect()` checks. Documented in Section 2 as a low-priority follow-up, not fixed this session.
- Discovered `clerk webhooks listen --forward-to <url>` exists as a CLI-native alternative to needing ngrok/a tunnel for local webhook testing — not yet tried, flagged as the thing to investigate first in Step 3 before defaulting to a third-party tunnel tool.
- **What was NOT done this session:** no human has actually completed a sign-up through the live `<SignIn>`/`<SignUp>` UI yet — both dev servers are up and ready for it, but clicking through a browser form isn't something an agent session can do. Handed this off explicitly to the user as the immediate next step. Webhook secret still not real, so even once sign-up is tested, the local `users` table won't sync yet — that's Step 3, separate from Step 2.
- Both dev servers (`auth-service`, `npm run dev`) were left running in the background at the end of the session rather than killed, since the user's very next action is expected to be testing sign-up against them — a departure from Sessions 3/5's practice of killing background processes at session end, done deliberately so the user doesn't have to restart anything to test. **Session ends here** — Next Steps' Step 2 (human sign-up test) and Step 3 (real webhook secret) are both still open; Step 1 is now genuinely done.

---

## 7. Key Constraints to Never Violate (quick reference)

- No Firebase, anywhere, for anything.
- No Auth0/Supabase, or any third-party auth-as-a-service **other than Clerk** (Clerk is explicitly allowed as of Session 5, scoped to sign-in/sign-up/session issuance only — not as a general BaaS).
- No managed cloud database as the primary datastore — Postgres lives on the homelab.
- No managed object storage (S3/R2) as the primary file store — MinIO is primary.
- Only the reverse proxy container should ever be internet-facing on the homelab — Postgres/Redis/OpenSearch/MinIO stay on the internal Docker network only.
- Frontend (Vercel) and backend (homelab) talk only over HTTPS/WSS via the custom domain — never assume they're on the same host.
- The backend never stores or handles raw passwords anymore — Clerk owns credentials entirely. If any future code path tries to write to `password_hash`, that's a bug, not a feature.
