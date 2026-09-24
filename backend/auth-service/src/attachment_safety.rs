//! Safe HTTP response headers for serving user-uploaded attachment bytes
//! (chat message attachments, and anything else user-controlled served
//! straight out of Postgres by content-type).
//!
//! # The vulnerability this closes
//!
//! Attachment endpoints used to echo the *client-supplied* multipart
//! `Content-Type` straight back in the response header with
//! `Content-Disposition: inline`. A user could upload a file with
//! `Content-Type: text/html` (or `image/svg+xml`, which can embed
//! `<script>`) and its actual bytes containing a script payload — the
//! multipart parser never validates that the declared MIME type matches
//! the actual bytes. Anyone who then opened that attachment's URL (e.g.
//! clicking an image thumbnail that turned out not to be an image) got
//! it rendered *inline*, same-origin, as a real HTML document — a classic
//! stored XSS that could read/exfiltrate that victim's session.
//!
//! # The fix
//!
//! Only a small allowlist of genuinely safe-to-render-inline MIME types
//! (images, common video/audio, plain text, PDF) get to keep the
//! client-declared type and `inline` disposition. Everything else is
//! force-downloaded as `application/octet-stream` with
//! `Content-Disposition: attachment` regardless of what the uploader
//! claimed — so even a maliciously mislabeled file can only ever be
//! saved to disk, never executed/rendered by the browser. Every response
//! also carries `X-Content-Type-Options: nosniff` so a browser can't
//! second-guess (sniff) its way back into treating attachment/octet-stream
//! bytes as HTML anyway.

use axum::http::HeaderValue;

/// MIME types safe to render inline in a browser tab without becoming a
/// script-execution vector. Deliberately excludes `image/svg+xml` (SVG
/// can carry `<script>`/event-handler XSS just like HTML) and any
/// `text/html`/`application/xhtml+xml` variant.
fn is_safe_inline_mime(mime: &str) -> bool {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(
        base.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/bmp"
            | "image/x-icon"
            | "video/mp4"
            | "video/webm"
            | "video/ogg"
            | "audio/mpeg"
            | "audio/mp3"
            | "audio/wav"
            | "audio/ogg"
            | "audio/webm"
            | "text/plain"
            | "application/pdf"
    )
}

/// Returns the `(Content-Type, Content-Disposition)` header values to use
/// when serving a user-uploaded attachment's bytes back to a client,
/// given the filename and the MIME type the uploader's client claimed.
/// See module docs for why this can't just echo the claimed type back.
pub fn safe_attachment_headers(claimed_mime: &str, filename: &str) -> (HeaderValue, HeaderValue) {
    let safe_filename = filename.replace(['"', '\\', '\r', '\n'], "_");
    if is_safe_inline_mime(claimed_mime) {
        let ct = HeaderValue::from_str(claimed_mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
        let cd = HeaderValue::from_str(&format!("inline; filename=\"{safe_filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("inline"));
        (ct, cd)
    } else {
        let ct = HeaderValue::from_static("application/octet-stream");
        let cd = HeaderValue::from_str(&format!("attachment; filename=\"{safe_filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
        (ct, cd)
    }
}

/// `X-Content-Type-Options: nosniff` header value — attach to every
/// attachment response alongside `safe_attachment_headers` so a browser
/// can't MIME-sniff its way around the Content-Type we just picked.
pub fn nosniff_header() -> (axum::http::HeaderName, HeaderValue) {
    (
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    )
}
