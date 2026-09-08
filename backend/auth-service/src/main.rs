mod clerk;
mod dms;
mod friends;
mod guilds;
mod profiles;
mod routes;
mod sounds;
mod webhooks;
mod ws;
mod admin;

use axum::{
    routing::{get, post, put},
    Json, Router,
};
use clerk::ClerkVerifier;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::net::SocketAddr;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;
use ws::WsHub;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub clerk_verifier: ClerkVerifier,
    pub clerk_webhook_secret: Option<String>,
    pub ws_hub: WsHub,
}

// Required by the `ClerkUser` extractor (see clerk.rs) so it can pull just
// the verifier out of AppState without needing the whole state type.
impl axum::extract::FromRef<AppState> for ClerkVerifier {
    fn from_ref(state: &AppState) -> Self {
        state.clerk_verifier.clone()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // NOTE: local dev Postgres runs on host port 5433, not the default 5432 —
    // this machine has a pre-existing native Windows Postgres service bound
    // to 5432 that isn't part of this project. See docker-compose.yml.
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://noschat:noschat@localhost:5433/noschat".to_string());

    // Clerk's per-instance JWKS URL, e.g.
    // https://<your-instance>.clerk.accounts.dev/.well-known/jwks.json
    // (or your custom Frontend API domain, if configured). Required —
    // without it every protected route fails closed at request time.
    let clerk_jwks_url = std::env::var("CLERK_JWKS_URL").unwrap_or_else(|_| {
        tracing::warn!(
            "CLERK_JWKS_URL not set — /me and every other Clerk-protected route will fail \
             verification until this points at your real Clerk instance's JWKS endpoint."
        );
        String::new()
    });

    // Placeholder detection: treat both "unset" and "still the example
    // placeholder value" as unconfigured. A raw `whsec_changeme` slipping
    // through from a copy-pasted .env is a very easy mistake to make and
    // should be just as loud as leaving the var out entirely.
    let clerk_webhook_secret = std::env::var("CLERK_WEBHOOK_SECRET")
        .ok()
        .filter(|s| !s.is_empty() && s != "whsec_changeme");
    if clerk_webhook_secret.is_none() {
        tracing::warn!(
            "\n\
            ============================================================\n\
            CLERK_WEBHOOK_SECRET is not set (or is still the placeholder\n\
            `whsec_changeme`). POST /webhooks/clerk will reject every\n\
            request with 500 until this is fixed.\n\
            \n\
            This is NOT fatal for sign-in/sign-up: a lazy-sync fallback in\n\
            GET /me (see routes.rs) will create the local `users` row on\n\
            first authenticated request even if the webhook never fires.\n\
            But webhook-driven updates/deletes (username changes, account\n\
            deletion propagating from Clerk) will NOT sync until this is\n\
            configured. To fix it, do ONE of:\n\
            \n\
            Option A — Clerk dashboard (needs a public URL):\n\
              1. Deploy/tunnel this backend so it has a public HTTPS URL\n\
                 (e.g. your homelab's domain, or a tunnel like ngrok/\n\
                 cloudflared for local testing).\n\
              2. Clerk dashboard -> your app -> Webhooks -> Add Endpoint.\n\
              3. Endpoint URL: https://<your-public-url>/webhooks/clerk\n\
              4. Subscribe to events: user.created, user.updated, user.deleted\n\
              5. Copy the \"Signing Secret\" (starts with whsec_) into\n\
                 CLERK_WEBHOOK_SECRET in backend/auth-service/.env\n\
              6. Restart this service.\n\
            \n\
            Option B — Clerk CLI local relay (no public URL needed):\n\
              1. npm install -g clerk   (if not already installed)\n\
              2. clerk webhooks listen --forward-to http://localhost:4000/webhooks/clerk\n\
              3. The CLI prints a signing secret — copy it into\n\
                 CLERK_WEBHOOK_SECRET in backend/auth-service/.env\n\
              4. Restart this service. Keep the `clerk webhooks listen`\n\
                 process running while developing locally.\n\
            ============================================================"
        );
    }

    // Attempt to connect, but don't crash the whole service if the DB isn't up yet
    // during early local scaffolding — /health should still report DB status,
    // and routes that need the DB will simply fail per-request if it's down.
    let pool_result = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await;

    let db_ok = pool_result.is_ok();
    if let Err(ref e) = pool_result {
        tracing::warn!("Could not connect to Postgres at startup: {e}. /health will report db: false until it's reachable, and /me and the webhook will fail until then too.");
    }

    // If the initial connection failed, still build a lazy pool so the
    // process can serve /health and retry DB connectivity on first real
    // request, rather than requiring a restart once Postgres comes up.
    let db = match pool_result {
        Ok(pool) => pool,
        Err(_) => PgPoolOptions::new()
            .max_connections(5)
            .connect_lazy(&database_url)?,
    };

    // Run any pending migrations automatically on startup rather than
    // requiring a manual `sqlx migrate run` every session — safe to call
    // repeatedly (sqlx tracks applied migrations in `_sqlx_migrations`).
    // Only attempted if the initial connection succeeded; if Postgres isn't
    // up yet, skip and let /health report db: false as before.
    if db_ok {
        if let Err(e) = sqlx::migrate!().run(&db).await {
            tracing::error!("failed to run migrations: {e:#}");
        }
    }

    let state = AppState {
        db,
        clerk_verifier: ClerkVerifier::new(clerk_jwks_url),
        clerk_webhook_secret,
        ws_hub: WsHub::default(),
    };

    let app = Router::new()
        .route("/health", get(move || health(db_ok)))
        .route("/me", get(routes::me))
        .route("/webhooks/clerk", post(webhooks::clerk_webhook))
        .route("/ws", get(ws::ws_upgrade))
        .route("/friends", get(friends::list_friends))
        .route("/friends/requests", post(friends::send_request))
        .route("/friends/requests/{id}/accept", post(friends::accept_request))
        .route("/friends/requests/{id}/decline", post(friends::decline_request))
        .route("/friends/{id}", axum::routing::delete(friends::remove_friend))
        .route("/dms", get(dms::list_dms).post(dms::open_dm))
        .route("/dms/{id}/messages", get(dms::list_messages).post(dms::send_message))
        .route("/dms/{dm_id}/messages/{message_id}", axum::routing::patch(dms::edit_message).delete(dms::delete_message))
        .route("/dms/{dm_id}/messages/{message_id}/reactions", post(dms::toggle_reaction))
        .route("/dms/{id}/read", post(dms::mark_read))
        .route("/guilds", get(guilds::list_guilds).post(guilds::create_guild))
        .route("/guilds/{id}", get(guilds::get_guild).patch(guilds::update_guild).delete(guilds::delete_guild))
        .route("/guilds/{id}/leave", post(guilds::leave_guild))
        .route("/guilds/{id}/members", get(guilds::list_members))
        .route("/guilds/{id}/members/{user_id}", axum::routing::delete(guilds::kick_member))
        .route(
            "/guilds/{id}/members/{user_id}/roles/{role_id}",
            put(guilds::assign_role).delete(guilds::unassign_role),
        )
        .route("/guilds/{id}/channels", post(guilds::create_channel))
        .route(
            "/guilds/{id}/channels/{channel_id}",
            axum::routing::patch(guilds::update_channel).delete(guilds::delete_channel),
        )
        .route(
            "/guilds/{id}/channels/{channel_id}/messages",
            get(guilds::list_channel_messages).post(guilds::send_channel_message),
        )
        .route(
            "/guilds/{guild_id}/channels/{channel_id}/messages/{message_id}",
            axum::routing::patch(guilds::edit_channel_message).delete(guilds::delete_channel_message),
        )
        .route(
            "/guilds/{guild_id}/channels/{channel_id}/messages/{message_id}/reactions",
            post(guilds::toggle_channel_reaction),
        )
        .route("/guilds/{id}/categories", post(guilds::create_category))
        .route("/guilds/{id}/roles", get(guilds::list_roles).post(guilds::create_role))
        .route(
            "/guilds/{id}/roles/{role_id}",
            axum::routing::patch(guilds::update_role).delete(guilds::delete_role),
        )
        .route("/guilds/{id}/invites", get(guilds::list_invites).post(guilds::create_invite))
        .route("/guilds/{id}/invites/{code}", axum::routing::delete(guilds::revoke_invite))
        .route("/invites/{code}", get(guilds::preview_invite))
        .route("/invites/{code}/accept", post(guilds::accept_invite))
        .route("/me/profile", get(profiles::get_own_profile).patch(profiles::update_profile))
        .route("/me/presence", put(profiles::set_presence))
        .route("/users/{id}", get(profiles::get_public_profile))
        .route("/me/sounds", get(sounds::get_sounds))
        .route("/me/sounds/{slot}/preset", put(sounds::set_preset))
        .route("/me/sounds/{slot}/upload", post(sounds::upload_custom))
        .route("/me/sounds/{slot}/file", get(sounds::get_custom_file))
        .route("/admin/me", get(admin::admin_whoami))
        .route("/admin/stats", get(admin::admin_stats))
        .route("/admin/users", get(admin::admin_list_users))
        .route("/admin/users/{id}", axum::routing::delete(admin::admin_delete_user))
        .route("/admin/guilds", get(admin::admin_list_guilds))
        .route("/admin/guilds/{id}", axum::routing::delete(admin::admin_delete_guild))
        .fallback(routes::not_found)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 4000));
    tracing::info!("auth-service listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health(db_ok: bool) -> Json<Value> {
    Json(json!({ "status": "ok", "service": "auth-service", "db": db_ok }))
}
