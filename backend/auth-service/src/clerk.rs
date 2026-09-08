//! Clerk JWT verification (networked JWKS lookup, cached in memory).
//!
//! Clerk issues short-lived session JWTs (RS256) signed against a per-instance
//! JWKS. We verify them here rather than trusting the frontend, since the
//! frontend is untrusted input as far as this backend is concerned — every
//! protected route should go through `ClerkUser` (see below), not just read
//! `sub` out of an unverified token.
//!
//! JWKS is fetched from `CLERK_JWKS_URL` (e.g.
//! `https://<your-instance>.clerk.accounts.dev/.well-known/jwks.json`, or
//! your custom Frontend API domain if you've set one up) and cached for
//! `JWKS_CACHE_SECS` to avoid hitting Clerk on every request. Keys do
//! occasionally rotate, so on a verification failure we force one refetch
//! before giving up, in case the cache is just stale.

use axum::{
    extract::{FromRef, FromRequestParts},
    http::{request::Parts, StatusCode},
    RequestPartsExt,
};
use axum_extra::headers::{authorization::Bearer, Authorization};
use axum_extra::TypedHeader;
use jsonwebtoken::{
    decode, decode_header,
    jwk::{AlgorithmParameters, JwkSet},
    Algorithm, DecodingKey, Validation,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const JWKS_CACHE_SECS: u64 = 300;

#[derive(Clone)]
pub struct ClerkVerifier {
    jwks_url: String,
    http: reqwest::Client,
    cache: Arc<RwLock<Option<(Instant, JwkSet)>>>,
}

impl ClerkVerifier {
    pub fn new(jwks_url: String) -> Self {
        Self {
            jwks_url,
            http: reqwest::Client::new(),
            cache: Arc::new(RwLock::new(None)),
        }
    }

    async fn jwks(&self, force_refresh: bool) -> anyhow::Result<JwkSet> {
        if !force_refresh {
            let cached = self.cache.read().await;
            if let Some((fetched_at, set)) = cached.as_ref() {
                if fetched_at.elapsed() < Duration::from_secs(JWKS_CACHE_SECS) {
                    return Ok(set.clone());
                }
            }
        }

        let set: JwkSet = self
            .http
            .get(&self.jwks_url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        *self.cache.write().await = Some((Instant::now(), set.clone()));
        Ok(set)
    }

    /// Verifies a Clerk session JWT and returns its claims. Retries once
    /// against a freshly-fetched JWKS if verification fails against the
    /// cached set, to tolerate Clerk's occasional key rotation.
    pub async fn verify(&self, token: &str) -> anyhow::Result<ClerkClaims> {
        match self.verify_against(token, false).await {
            Ok(claims) => Ok(claims),
            Err(_) => self.verify_against(token, true).await,
        }
    }

    async fn verify_against(&self, token: &str, force_refresh: bool) -> anyhow::Result<ClerkClaims> {
        let header = decode_header(token)?;
        let kid = header
            .kid
            .ok_or_else(|| anyhow::anyhow!("token header missing kid"))?;

        let set = self.jwks(force_refresh).await?;
        let jwk = set
            .find(&kid)
            .ok_or_else(|| anyhow::anyhow!("no matching JWKS key for kid {kid}"))?;

        let AlgorithmParameters::RSA(rsa) = &jwk.algorithm else {
            anyhow::bail!("unsupported JWK algorithm (expected RSA)");
        };
        let decoding_key = DecodingKey::from_rsa_components(&rsa.n, &rsa.e)?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_aud = false; // Clerk's default template doesn't set aud
        let data = decode::<ClerkClaims>(token, &decoding_key, &validation)?;
        Ok(data.claims)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClerkClaims {
    pub sub: String, // Clerk user id, e.g. "user_2abc..."
    pub exp: usize,
    #[serde(default)]
    pub email: Option<String>,
}

/// Axum extractor — put `ClerkUser` in a handler's arguments to require and
/// verify a Clerk bearer token. Returns 401 automatically if it's missing,
/// malformed, or fails verification.
pub struct ClerkUser(pub ClerkClaims);

impl<S> FromRequestParts<S> for ClerkUser
where
    ClerkVerifier: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let TypedHeader(Authorization(bearer)) = parts
            .extract::<TypedHeader<Authorization<Bearer>>>()
            .await
            .map_err(|_| (StatusCode::UNAUTHORIZED, "missing bearer token"))?;

        let verifier = ClerkVerifier::from_ref(state);
        let claims = verifier
            .verify(bearer.token())
            .await
            .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid or expired token"))?;

        Ok(ClerkUser(claims))
    }
}
