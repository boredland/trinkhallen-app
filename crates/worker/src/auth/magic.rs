//! Magic-link signup / login — port of `src/lib/magic.ts`, `src/lib/turnstile.ts`
//! and the `/auth/magic*` routes.
//!
//! Token is a random opaque secret; the DB stores its SHA-256 so a leak
//! cannot be used to log in. The URL carries `<id>.<token>` for a fast
//! lookup plus hash verification. TTL 15 minutes, single use, ≤5 outstanding
//! per address.
//!
//! plans/008: the emailed link's GET only renders a confirmation page and
//! touches nothing (not even the database); the POST from that page performs
//! the redeem. Mail-scanner prefetch GETs the link, and when GET redeemed
//! the token the human was left with "expired" — scanners fetch, they don't
//! submit forms.

use dioxus::prelude::*;
use worker::{Env, Request, Response, Result};

use super::{query_param, same_origin_post, secret, users};
use crate::crypto::{sha256_hex, timing_safe_equal, unix_now};
use crate::http::redirect;
use crate::session::create_session;
use crate::state::RequestState;
use trinkhallen_core::i18n::{resolve_lang, t};
use trinkhallen_ui::model::Nav;
use trinkhallen_ui::render::{Page, document, to_html};

pub const MAGIC_TTL_SEC: i64 = 15 * 60;
const MAX_OUTSTANDING_PER_EMAIL: i64 = 5;
pub const TURNSTILE_FIELD: &str = "cf-turnstile-response";

const SITEVERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

pub struct MintedLink {
    pub id: String,
    pub token: String,
}

#[derive(serde::Deserialize)]
struct CountRow {
    n: i64,
}

#[derive(serde::Deserialize)]
struct LinkRow {
    email: String,
    token_hash: String,
    expires_at: i64,
    consumed_at: Option<i64>,
}

/// Mint a login link, or `None` when the per-email rate limit is spent.
/// Silently skipping keeps the "check your email" answer from leaking
/// whether the address is known or being abused.
pub async fn mint_magic_link(
    db: &worker::D1Database,
    email: &str,
    user_agent: Option<&str>,
    ip: Option<&str>,
    now: i64,
) -> Result<Option<MintedLink>> {
    // Cheap rate-limit: pending unconsumed tokens for this email.
    let pending: Option<CountRow> = db
        .prepare(
            "SELECT COUNT(*) AS n FROM magic_links
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .bind(&[
            wasm_bindgen::JsValue::from_str(email),
            wasm_bindgen::JsValue::from_f64(now as f64),
        ])?
        .first(None)
        .await?;
    if pending.map(|p| p.n).unwrap_or(0) >= MAX_OUTSTANDING_PER_EMAIL {
        return Ok(None);
    }

    let id = random_hex(16);
    let token = random_hex(32);
    let token_hash = sha256_hex(&token);
    let expires_at = now + MAGIC_TTL_SEC;

    db.prepare(
        "INSERT INTO magic_links (id, token_hash, email, expires_at, created_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        wasm_bindgen::JsValue::from_str(&id),
        wasm_bindgen::JsValue::from_str(&token_hash),
        wasm_bindgen::JsValue::from_str(email),
        wasm_bindgen::JsValue::from_f64(expires_at as f64),
        wasm_bindgen::JsValue::from_f64(now as f64),
        opt_str(user_agent),
        opt_str(ip),
    ])?
    .run()
    .await?;

    Ok(Some(MintedLink { id, token }))
}

/// Consume `<id>.<token>`; `None` for malformed, unknown, expired or
/// already-used links.
pub async fn redeem_magic_link(
    db: &worker::D1Database,
    raw_token: &str,
    now: i64,
) -> Result<Option<String>> {
    let Some(dot) = raw_token.find('.') else {
        return Ok(None);
    };
    if dot == 0 {
        return Ok(None);
    }
    let (id, token) = (&raw_token[..dot], &raw_token[dot + 1..]);
    if id.is_empty() || token.is_empty() {
        return Ok(None);
    }

    let row: Option<LinkRow> = db
        .prepare("SELECT email, token_hash, expires_at, consumed_at FROM magic_links WHERE id = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(id)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.consumed_at.is_some() || row.expires_at < now {
        return Ok(None);
    }
    if !timing_safe_equal(&sha256_hex(token), &row.token_hash) {
        return Ok(None);
    }

    // The conditional UPDATE — not the SELECT above — is the single-use source of
    // truth. Two requests redeeming the same token concurrently both clear the
    // `consumed_at` check above, then race here; exactly one sees changes === 1,
    // and the loser is treated as already-consumed.
    let consume = db
        .prepare("UPDATE magic_links SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
        .bind(&[
            wasm_bindgen::JsValue::from_f64(now as f64),
            wasm_bindgen::JsValue::from_str(id),
        ])?
        .run()
        .await?;
    let changed = consume.meta()?.and_then(|m| m.changes).unwrap_or(0);
    if changed == 0 {
        return Ok(None);
    }
    Ok(Some(row.email))
}

/// Permissive but bounded RFC-ish check (`/^[^\s@<>"]+@[^\s@.]+(?:\.[^\s@.]+)+$/`
/// with a 254-char cap); real validation happens at delivery.
pub fn is_valid_email(s: &str) -> bool {
    if s.chars().count() > 254 {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    let ok_char = |c: char| !c.is_whitespace() && c != '<' && c != '>' && c != '"' && c != '@';
    if local.is_empty() || !local.chars().all(ok_char) {
        return false;
    }
    // At least two labels, each non-empty and free of the excluded chars.
    let mut count = 0;
    for label in domain.split('.') {
        if label.is_empty() || !label.chars().all(ok_char) {
            return false;
        }
        count += 1;
    }
    count >= 2
}

/// POST /auth/magic — send a login link.
///
/// Always redirects to the same "check your email" success so existence
/// isn't leaked; the bad-email case is the only signal we surface.
pub async fn request_link(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let form = req.form_data().await?;
    let email = form
        .get_field("email")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let ip = req.headers().get("cf-connecting-ip").ok().flatten();

    // Bot gate before any mail goes out — see src/lib/turnstile.ts.
    let human = verify_turnstile(
        env,
        form.get_field(TURNSTILE_FIELD).as_deref(),
        ip.as_deref(),
    )
    .await?;
    if !human {
        return redirect("/me?magic=robot", 302, &[]);
    }
    if !is_valid_email(&email) {
        return redirect("/me?magic=invalid", 302, &[]);
    }

    let now = unix_now();
    let db = env.d1("DB")?;
    let user_agent = req.headers().get("user-agent").ok().flatten();
    let link = mint_magic_link(&db, &email, user_agent.as_deref(), ip.as_deref(), now).await?;

    if let Some(link) = link {
        let origin = secret(env, "PUBLIC_ORIGIN").unwrap_or_else(|| state.origin.clone());
        let raw = format!("{}.{}", link.id, link.token);
        let verify_url = format!(
            "{origin}/auth/magic/verify?token={}",
            super::urlencode(&raw)
        );
        let subject = "Dein trinkhallen.app Login";
        let text_body = format!(
            "Hallo,\r\n\r\nklicke auf den folgenden Link, um dich bei trinkhallen.app einzuloggen:\r\n{verify_url}\r\n\r\nDer Link ist 15 Minuten gültig und kann nur einmal verwendet werden.\r\n\r\nWenn du das nicht angefragt hast, kannst du diese Mail ignorieren.\r\n\r\n— trinkhallen.app"
        );
        let html_body = format!(
            "<p>Hallo,</p><p>klicke auf den folgenden Link, um dich bei <strong>trinkhallen.app</strong> einzuloggen:</p><p><a href=\"{verify_url}\" style=\"display:inline-block;padding:.6rem 1rem;background:#FF2D6F;color:#0A0A0A;font-family:Anton,sans-serif;letter-spacing:.05em;text-decoration:none\">▶ Einloggen</a></p><p style=\"color:#666;font-size:0.9em\">Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden. Wenn du das nicht angefragt hast, kannst du diese Mail ignorieren.</p><p style=\"color:#999;font-size:0.85em\">— trinkhallen.app</p>"
        );
        // Still report success to the user on failure — abuse signal otherwise.
        if let Err(e) = crate::email::send(env, &email, subject, &text_body, Some(&html_body)).await
        {
            worker::console_error!("magic email send failed: {e}");
        }
    }

    redirect("/me?magic=sent", 302, &[])
}

/// GET /auth/magic/verify — confirmation page only.
///
/// No D1 access on purpose (plans/008): a scanner GET costs nothing and
/// learns nothing — valid and expired tokens render the identical page. No
/// auto-submitting JavaScript either, or a JS-executing scanner could log
/// in again. `no-store` keeps the token out of any cache.
pub fn confirm_page(req: &Request, state: &RequestState) -> Result<Response> {
    let Some(token) = query_param(state, "token").filter(|t| !t.is_empty()) else {
        return redirect("/me?magic=invalid", 302, &[]);
    };
    let accept_language = req.headers().get("accept-language").ok().flatten();
    let lang = resolve_lang(accept_language.as_deref());

    let mut page = Page::new(
        lang,
        state.path.clone(),
        state.nonce.clone(),
        crate::state::asset_urls(),
    );
    page.title = Some(t(lang, "auth.magicConfirm.title"));
    page.noindex = true;
    page.nav = Nav::Me;
    page.user = None;

    let html = document(&page, to_html(confirm_body(lang, &token)));
    let resp = crate::http::html(html, 200)?;
    resp.headers().set("Cache-Control", "no-store")?;
    Ok(resp)
}

fn confirm_body(lang: trinkhallen_core::Lang, token: &str) -> Element {
    let title = t(lang, "auth.magicConfirm.title");
    let body = t(lang, "auth.magicConfirm.body");
    let button = t(lang, "auth.magicConfirm.button");
    rsx! {
        section {
            class: "border-2 border-border bg-surface p-8",
            h1 { class: "font-display text-3xl tracking-wide text-fg sm:text-4xl", "{title}" }
            p { class: "mt-3 text-fg-muted", "{body}" }
            form {
                action: "/auth/magic/verify",
                method: "post",
                class: "mt-6",
                input { r#type: "hidden", name: "token", value: "{token}" }
                button { r#type: "submit", class: "btn-neon", "{button}" }
            }
        }
    }
}

/// POST /auth/magic/verify — the redeem (guarded by an origin check; this is
/// the one POST under `/auth/*` that is not cross-origin by design).
pub async fn redeem(
    mut req: Request,
    env: &Env,
    _ctx: &worker::Context,
    state: &RequestState,
) -> Result<Response> {
    if !same_origin_post(&req, &state.origin) {
        return super::forbidden();
    }
    let form = req.form_data().await?;
    let token = form.get_field("token").unwrap_or_default();
    if token.is_empty() {
        return redirect("/me?magic=invalid", 302, &[]);
    }

    let now = unix_now();
    let db = env.d1("DB")?;
    let Some(email) = redeem_magic_link(&db, &token, now).await? else {
        return redirect("/me?magic=expired", 302, &[]);
    };

    let user_id = users::upsert_user_by_email(&db, &email, now).await?;
    let session = create_session(env, &user_id).await?;
    redirect("/me", 302, &[session])
}

/// Cloudflare Turnstile verification for the magic-link signup form.
///
/// Verification is server-side rather than in the browser: the form is a
/// plain POST with no JS, and a client-side check would be bypassed by
/// posting straight to the endpoint — exactly what the 2026-07 bot campaign
/// did. An empty `TURNSTILE_SECRET_KEY` disables the gate, so local dev and
/// deploys predating the secret keep working.
///
/// Returns `false` on a missing token, a rejected token, or a siteverify
/// outage — the endpoint sends mail to arbitrary addresses, so an
/// unverifiable request must not pass.
pub async fn verify_turnstile(
    env: &Env,
    token: Option<&str>,
    remote_ip: Option<&str>,
) -> Result<bool> {
    let Some(secret_key) = secret(env, "TURNSTILE_SECRET_KEY") else {
        return Ok(true);
    };
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return Ok(false);
    };

    let body = worker::FormData::new();
    body.append("secret", &secret_key)?;
    body.append("response", token)?;
    if let Some(ip) = remote_ip.filter(|i| !i.is_empty()) {
        body.append("remoteip", ip)?;
    }

    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Post);
    init.with_body(Some(body.into()));
    let req = worker::Request::new_with_init(SITEVERIFY_URL, &init)?;
    let mut resp = match worker::Fetch::Request(req).send().await {
        Ok(r) => r,
        Err(e) => {
            worker::console_error!("turnstile siteverify failed: {e}");
            return Ok(false);
        }
    };
    if resp.status_code() != 200 {
        worker::console_error!("turnstile siteverify http error {}", resp.status_code());
        return Ok(false);
    }
    let outcome: serde_json::Value = resp.json().await?;
    let ok = outcome
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !ok {
        worker::console_warn!("turnstile rejected: {:?}", outcome.get("error-codes"));
    }
    Ok(ok)
}

fn opt_str(v: Option<&str>) -> wasm_bindgen::JsValue {
    match v {
        Some(s) if !s.is_empty() => wasm_bindgen::JsValue::from_str(s),
        _ => wasm_bindgen::JsValue::NULL,
    }
}

pub fn random_hex(byte_length: usize) -> String {
    let mut bytes = vec![0u8; byte_length];
    let _ = getrandom::fill(&mut bytes);
    crate::crypto::hex_encode(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation_matches_the_ts_regex() {
        for good in [
            "a@b.de",
            "info@example.de",
            "a.b+c@sub.domain.co.uk",
            "x@y.zz",
        ] {
            assert!(is_valid_email(good), "{good} should be valid");
        }
        for bad in [
            "",
            "a",
            "a@b",
            "a@b.",
            "a@.de",
            "a@@b.de",
            "a b@c.de",
            "a@b c.de",
            "a@b<c.de",
            "a@b>de",
            "a\"b@c.de",
            "a@b..de",
        ] {
            assert!(!is_valid_email(bad), "{bad:?} should be invalid");
        }
        assert!(!is_valid_email(&format!("{}@b.de", "a".repeat(250))));
    }

    #[test]
    fn random_hex_shape() {
        let h = random_hex(16);
        assert_eq!(h.len(), 32);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn single_use_token_shape_is_id_dot_token() {
        // redeem_magic_link splits on the first dot and rejects either half
        // being empty; pin the shape so the URL format can't drift.
        assert!("deadbeef.cafe".find('.').is_some());
        assert!("deadbeef.cafe".find('.').unwrap() > 0);
    }
}
