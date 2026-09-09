//! GIF search — thin server-side proxy to the Tenor API so the API key
//! never has to live in frontend JS. Requires TENOR_API_KEY in the
//! backend's environment; if unset, the endpoint returns a clear 503
//! rather than silently failing, so the frontend can show "GIF search
//! isn't configured" instead of a generic error.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::clerk::ClerkUser;
use crate::AppState;

#[derive(Deserialize)]
pub struct GifSearchParams {
    pub q: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Serialize)]
pub struct GifResult {
    pub id: String,
    pub title: String,
    /// Full-quality GIF URL (used when actually sending/rendering).
    pub url: String,
    /// Small preview GIF URL (used in the picker grid — much lighter).
    pub preview_url: String,
    pub width: i64,
    pub height: i64,
}

#[derive(Serialize)]
pub struct GifSearchResponse {
    pub results: Vec<GifResult>,
}

/// `GET /gifs/search?q=cats&limit=24` — if `q` is empty/missing, returns
/// Tenor's trending/featured feed instead (same pattern Discord's own GIF
/// picker uses for its default "browse" state before you type anything).
pub async fn search(
    State(_state): State<AppState>,
    ClerkUser(_claims): ClerkUser,
    Query(params): Query<GifSearchParams>,
) -> Result<Json<GifSearchResponse>, (StatusCode, Json<serde_json::Value>)> {
    let api_key = std::env::var("TENOR_API_KEY").ok();
    let Some(api_key) = api_key.filter(|k| !k.trim().is_empty()) else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "GIF search isn't configured (missing TENOR_API_KEY)" })),
        ));
    };

    let limit = params.limit.unwrap_or(24).clamp(1, 50);
    let query = params.q.unwrap_or_default();
    let query = query.trim();

    let url = if query.is_empty() {
        format!(
            "https://tenor.googleapis.com/v2/featured?key={api_key}&limit={limit}&media_filter=gif,tinygif&contentfilter=medium"
        )
    } else {
        let encoded = urlencoding_lite(query);
        format!(
            "https://tenor.googleapis.com/v2/search?q={encoded}&key={api_key}&limit={limit}&media_filter=gif,tinygif&contentfilter=medium"
        )
    };

    let resp = reqwest::get(&url).await.map_err(|e| {
        tracing::error!("tenor request failed: {e:#}");
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "GIF search upstream failed" })),
        )
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        tracing::error!("tenor returned non-success status {status}");
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("GIF search upstream returned {status}") })),
        ));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| {
        tracing::error!("tenor response parse failed: {e:#}");
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "GIF search upstream returned malformed data" })),
        )
    })?;

    let empty = Vec::new();
    let items = body["results"].as_array().unwrap_or(&empty);
    let results: Vec<GifResult> = items
        .iter()
        .filter_map(|item| {
            let id = item["id"].as_str()?.to_string();
            let title = item["content_description"].as_str().unwrap_or("").to_string();
            let gif = &item["media_formats"]["gif"];
            let tiny = &item["media_formats"]["tinygif"];
            let url = gif["url"].as_str()?.to_string();
            let preview_url = tiny["url"].as_str().unwrap_or(&url).to_string();
            let dims = gif["dims"].as_array();
            let width = dims.and_then(|d| d.first()).and_then(|v| v.as_i64()).unwrap_or(0);
            let height = dims.and_then(|d| d.get(1)).and_then(|v| v.as_i64()).unwrap_or(0);
            Some(GifResult { id, title, url, preview_url, width, height })
        })
        .collect();

    Ok(Json(GifSearchResponse { results }))
}

/// Minimal query-string encoder — avoids pulling in a full `urlencoding`
/// crate dependency for one call site. Handles the characters that
/// realistically show up in a GIF search query (spaces, punctuation).
fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
