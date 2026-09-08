mod clerk;
mod dms;
mod friends;
mod routes;
mod sounds;
mod webhooks;
mod ws;

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

    let clerk_webhook_secret = std::env::var("CLERK_WEBHOOK_SECRET").ok();
    if clerk_webhook_secret.is_none() {
        tracing::warn!(
            "CLERK_WEBHOOK_SECRET not set — /webhooks/clerk will reject everything with a 500 \
             until this is set from the Clerk dashboard's webhook endpoint config."
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
        .route("/dms/{id}/read", post(dms::mark_read))
        .route("/me/sounds", get(sounds::get_sounds))
        .route("/me/sounds/{slot}/preset", put(sounds::set_preset))
        .route("/me/sounds/{slot}/upload", post(sounds::upload_custom))
        .route("/me/sounds/{slot}/file", get(sounds::get_custom_file))
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
