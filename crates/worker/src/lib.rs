//! trinkhallen.app Cloudflare Worker: routing, middleware (security headers +
//! per-request CSP nonce, session, CSRF, language redirect), D1 access and
//! SSR through `trinkhallen-ui`.
//!
//! See `crates/worker/src/routes` for the per-route handlers.

pub mod assets;
pub mod assets_manifest;
pub mod auth;
pub mod checkins;
pub mod crypto;
pub mod csrf;
pub mod db;
pub mod email;
pub mod http;
pub mod lang;
pub mod moderation;
pub mod notify;
pub mod panel;
pub mod ratings;
pub mod reports;
pub mod routes;
pub mod session;
pub mod signals;
pub mod state;
pub mod submissions;
pub mod users;
pub mod util;

use worker::{Context, Env, Method, Request, Response, Result};

use crate::state::{RequestState, asset_urls};

#[worker::event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    let nonce = new_nonce();
    match handle(req, &env, &ctx, &nonce).await {
        Ok(resp) => {
            let mut resp = http::mutable(resp);
            secure_headers(&mut resp, &nonce)?;
            Ok(resp)
        }
        Err(err) => {
            // Deliberate HTTP errors are returned as responses (the csrf 403,
            // the role-gate 403); only genuinely unexpected failures land here.
            worker::console_error!("500: {err}");
            let mut resp = http::text("500 — Da ist was schiefgegangen.", 500)?;
            secure_headers(&mut resp, &nonce)?;
            Ok(resp)
        }
    }
}

/// Hourly reconciliation of `pr_opened` reports/submissions against GitHub —
/// see `crate::moderation`.
#[worker::event(scheduled)]
async fn scheduled(_event: worker::ScheduledEvent, env: Env, _ctx: worker::ScheduleContext) {
    if let Err(err) = crate::moderation::reconcile_all(&env).await {
        worker::console_error!("reconcile failed: {err}");
    }
}

async fn handle(req: Request, env: &Env, ctx: &Context, nonce: &str) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_owned();
    let origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
    let method = req.method();

    // `attachUser`: missing/invalid sessions are silently `None`.
    let (user, session_cookie) = session::load_session(env, &req, ctx).await?;

    // CSRF: origin check on the app's own form surfaces.
    let content_type = http::header(&req, "content-type");
    let sec_fetch_site = http::header(&req, "sec-fetch-site");
    let origin_header = http::header(&req, "origin");
    let method_str = method.as_ref();
    if csrf::csrf_protected(method_str, &path)
        && !csrf::csrf_check(
            method_str,
            content_type.as_deref(),
            sec_fetch_site.as_deref(),
            origin_header.as_deref(),
            &origin,
        )
    {
        return http::text("Forbidden", 403);
    }

    // First-visit language handling — page GETs only (see `crate::lang`).
    let query = url.query().unwrap_or("").to_owned();
    if method == Method::Get && !get_intercepted(&path) {
        let lang_cookie = http::cookie_header(&req, lang::LANG_COOKIE);
        let accept_language = http::header(&req, "accept-language");
        let decision = lang::decide(
            &path,
            &query,
            lang_cookie.as_deref(),
            accept_language.as_deref(),
        );
        if let Some(location) = decision.location {
            let mut cookies = Vec::new();
            if let Some(c) = decision.set_cookie {
                cookies.push(c);
            }
            if let Some(c) = session_cookie {
                cookies.push(c);
            }
            return http::redirect(&location, 302, &cookies);
        }
    }

    let state = RequestState {
        lang: trinkhallen_core::i18n::lang_from_path(&path),
        user,
        nonce: nonce.to_owned(),
        origin,
        path,
        url,
        assets: asset_urls(),
        user_agent: http::header(&req, "user-agent"),
    };

    let resp = routes::dispatch(req, env, ctx, &state).await?;
    match session_cookie {
        Some(c) => http::with_cookie(resp, &c),
        None => Ok(resp),
    }
}

/// GET paths that earlier-mounted routers (auth, the kiosk APIs,
/// moderation's role gate, well-known) intercept before the language
/// middleware could see them. Everything else — including unknown paths —
/// goes through the language decision first.
fn get_intercepted(path: &str) -> bool {
    if matches!(
        path,
        "/auth/google"
            | "/auth/google/callback"
            | "/auth/apple"
            | "/auth/magic/verify"
            | "/api/kiosks"
            | "/api/kiosks/panel"
            | "/api/kiosks/nearest"
            | "/api/kiosks/nearest-open"
            | "/.well-known/assetlinks.json"
            | "/moderate"
            | "/en/moderate"
    ) {
        return true;
    }
    if path.starts_with("/api/moderate/") {
        return true;
    }
    // `/api/kiosks/:id` — one path segment.
    routes::is_kiosk_id_path(path)
}

/// Security headers as observed on production, plus the CSP
/// with this request's script nonce. `'wasm-unsafe-eval'` lets
/// the client bundle compile its wasm; it does not enable `eval()`.
fn secure_headers(resp: &mut Response, nonce: &str) -> Result<()> {
    let headers = resp.headers_mut();
    headers.set(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains; preload",
    )?;
    headers.set(
        "content-security-policy",
        &format!(
            "default-src 'self'; \
             font-src 'self' https://tiles.openfreemap.org; \
             style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob: https://lh3.googleusercontent.com https://tiles.openfreemap.org; \
             script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval' https://challenges.cloudflare.com; \
             frame-src 'self' https://challenges.cloudflare.com; \
             worker-src 'self' blob:; \
             connect-src 'self' https://tiles.openfreemap.org https://photon.komoot.io; \
             frame-ancestors 'none'"
        ),
    )?;
    headers.set("cross-origin-opener-policy", "same-origin")?;
    headers.set("cross-origin-resource-policy", "same-origin")?;
    headers.set("origin-agent-cluster", "?1")?;
    headers.set("referrer-policy", "no-referrer")?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("x-dns-prefetch-control", "off")?;
    headers.set("x-download-options", "noopen")?;
    headers.set("x-frame-options", "SAMEORIGIN")?;
    headers.set("x-permitted-cross-domain-policies", "none")?;
    headers.set("x-xss-protection", "0")?;
    Ok(())
}

/// Per-request script nonce: 16 random bytes, base64.
fn new_nonce() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    crate::crypto::base64_encode(&b)
}
