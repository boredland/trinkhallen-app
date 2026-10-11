//! Auth routes: Google OAuth, Sign in with Apple, magic link, logout.
//!
//! The SQL, cookie attributes, redirects and error strings are the behavioural
//! spec; comments here only note non-obvious decisions.
//!
//! Two security fixes from `plans/` are part of the spec, not deviations:
//!
//! - plans/006: the Google callback **fails closed** on a missing or
//!   mismatched `state` (401 before any network call). A previous provider
//!   library let this through; the check is owned here.
//! - plans/008: `GET /auth/magic/verify` renders a confirmation page and
//!   touches neither the database nor the session; only the POST redeems.

pub mod apple;
pub mod google;
pub mod magic;
pub mod users;

use worker::{Env, Method, Request, Response, Result};

use crate::http::{redirect, text};
use crate::state::RequestState;
use crate::util::env_str;

// Child modules read cookies through this, so the auth routes have exactly
// one cookie-jar entry point.
pub use crate::http::cookie_header;

/// One-shot CSRF state cookie for Google's redirect round-trip. The name is
/// deliberately generic (`state`): changing it
/// would strand in-flight flows.
pub const GOOGLE_STATE_COOKIE: &str = "state";
/// Apple's callback is a cross-site form POST, so its state cookie needs
/// `SameSite=None` and is scoped to the callback path.
pub const APPLE_STATE_COOKIE: &str = "__tk_apple_state";

/// Fail-closed OAuth `state` comparison (Google and Apple).
///
/// The previous library compared `undefined === undefined` and let a callback with
/// no `state` through (GHSA-fm3f-ch8h-qw8q); missing input must reject.
pub fn check_oauth_state(param: Option<&str>, cookie: Option<&str>) -> bool {
    match (param, cookie) {
        (Some(p), Some(c)) => !p.is_empty() && !c.is_empty() && p == c,
        _ => false,
    }
}

/// `Set-Cookie` value for a one-shot OAuth state cookie.
pub fn state_cookie(name: &str, value: &str, path: &str, same_site: &str) -> String {
    format!("{name}={value}; HttpOnly; Secure; SameSite={same_site}; Path={path}; Max-Age=600")
}

/// Clearing counterpart: same attributes as the set-cookie.
pub fn clear_cookie(name: &str, path: &str) -> String {
    format!("{name}=; Path={path}; Max-Age=0; HttpOnly; Secure")
}

/// `form-urlencoded` encoding for outbound token-exchange bodies.
pub fn encode_form(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&format!("{}={}", urlencode(k), urlencode(v)));
    }
    out
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Same-origin check for the one POST under `/auth/*` that must have it
/// (`POST /auth/magic/verify`, plans/008 step 4). Same rule as the global CSRF check:
/// `Sec-Fetch-Site` when the browser sends it, else a byte-equal `Origin`.
/// The Apple callback is deliberately NOT covered — its state cookie is the
/// guard there.
pub fn same_origin_post(req: &Request, origin: &str) -> bool {
    let sec_fetch_site = req.headers().get("sec-fetch-site").ok().flatten();
    if let Some(site) = sec_fetch_site {
        return site == "same-origin" || site == "none";
    }
    match req.headers().get("origin").ok().flatten() {
        Some(o) => o == origin,
        // No browser omits Origin on a form POST; anything else is a client
        // outside the threat model and gets the fail-closed answer.
        None => false,
    }
}

/// Query-string lookup on the request URL.
pub fn query_param(state: &RequestState, key: &str) -> Option<String> {
    state
        .url
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

pub async fn handle(
    req: Request,
    env: &Env,
    ctx: &worker::Context,
    state: &RequestState,
) -> Option<Result<Response>> {
    let path = state.path.as_str();
    match (req.method(), path) {
        (Method::Get, "/auth/google") => Some(google::start(env, state)),
        (Method::Get, "/auth/google/callback") => {
            Some(google::callback(req, env, ctx, state).await)
        }
        (Method::Get, "/auth/apple") => Some(apple::start(env, state)),
        (Method::Post, "/auth/apple/callback") => Some(apple::callback(req, env, ctx, state).await),
        (Method::Post, "/auth/magic") => Some(magic::request_link(req, env, state).await),
        (Method::Get, "/auth/magic/verify") => Some(magic::confirm_page(&req, state)),
        (Method::Post, "/auth/magic/verify") => Some(magic::redeem(req, env, ctx, state).await),
        (Method::Post, "/auth/logout") => Some(logout(req, env).await),
        _ => None,
    }
}

/// POST-only: logout deletes the server-side session row, so a GET would be
/// CSRF-able (SameSite=Lax cookies ride top-level cross-site GETs). The
/// profile page submits this via a form; no GET entry point exists.
async fn logout(req: Request, env: &Env) -> Result<Response> {
    let clearing = crate::session::destroy_session(&req, env).await?;
    redirect("/", 302, &[clearing])
}

/// OAuth callback URLs, honouring `PUBLIC_ORIGIN` when it is set.
pub fn callback_url(env: &Env, request_url: &str, suffix: &str) -> String {
    match env_str(env, "PUBLIC_ORIGIN") {
        Some(origin) if origin.starts_with("http") => format!("{origin}{suffix}"),
        _ => match origin_from_url(request_url) {
            Some(origin) => format!("{origin}{suffix}"),
            None => format!("https://trinkhallen.app{suffix}"),
        },
    }
}

/// `https://host/anything?x` → `https://host`.
pub fn origin_from_url(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split('/').next().unwrap_or(rest);
    if scheme.is_empty() || host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// 401 with no body.
pub fn unauthorized() -> Result<Response> {
    Ok(worker::Response::builder().with_status(401).empty())
}

/// CSRF rejection shape.
pub fn forbidden() -> Result<Response> {
    text("Forbidden", 403)
}

/// `POST` with an `application/x-www-form-urlencoded` body (token exchange).
pub async fn post_form(url: &str, body: &str) -> Result<Response> {
    let headers = worker::Headers::new();
    headers.set("content-type", "application/x-www-form-urlencoded")?;
    headers.set("accept", "application/json")?;
    let mut init = worker::RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(wasm_bindgen::JsValue::from_str(body)));
    let req = Request::new_with_init(url, &init)?;
    worker::Fetch::Request(req).send().await
}

/// `GET` with a bearer token (Google user info).
pub async fn get_bearer(url: &str, token: &str) -> Result<Response> {
    let headers = worker::Headers::new();
    headers.set("authorization", &format!("Bearer {token}"))?;
    let mut init = worker::RequestInit::new();
    init.with_method(Method::Get);
    init.with_headers(headers);
    let req = Request::new_with_init(url, &init)?;
    worker::Fetch::Request(req).send().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_state_fail_closed_matrix() {
        // plans/006: missing param, missing cookie, mismatch, empty values.
        assert!(!check_oauth_state(None, None));
        assert!(!check_oauth_state(Some("abc"), None));
        assert!(!check_oauth_state(None, Some("abc")));
        assert!(!check_oauth_state(Some("abc"), Some("xyz")));
        assert!(!check_oauth_state(Some(""), Some("")));
        assert!(!check_oauth_state(Some("abc"), Some("")));
        assert!(!check_oauth_state(Some(""), Some("abc")));
        assert!(check_oauth_state(Some("abc"), Some("abc")));
    }

    #[test]
    fn state_cookie_attributes() {
        let c = state_cookie("state", "s3cret", "/", "Lax");
        assert_eq!(
            c,
            "state=s3cret; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600"
        );
        let apple = state_cookie(APPLE_STATE_COOKIE, "x", "/auth/apple", "None");
        assert!(apple.contains("SameSite=None"));
        assert!(apple.contains("Path=/auth/apple"));
        assert!(clear_cookie(APPLE_STATE_COOKIE, "/auth/apple").contains("Max-Age=0"));
    }

    #[test]
    fn form_encoding() {
        assert_eq!(
            encode_form(&[("a", "b"), ("c", "d e&f")]),
            "a=b&c=d%20e%26f"
        );
        assert_eq!(urlencode("ä€"), "%C3%A4%E2%82%AC");
    }

    #[test]
    fn callback_origin_falls_back_to_the_request_host() {
        assert_eq!(
            origin_from_url("https://trinkhallen.app/auth/google/callback?x=1").as_deref(),
            Some("https://trinkhallen.app")
        );
        assert_eq!(
            origin_from_url("http://localhost:8787/x").as_deref(),
            Some("http://localhost:8787")
        );
        assert_eq!(origin_from_url("nope"), None);
    }
}
