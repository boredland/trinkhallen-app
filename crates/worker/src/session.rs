//! Signed-cookie sessions backed by the `sessions` table in D1.
//!
//! Port of `src/lib/session.ts` (the load half; `src/routes/auth.tsx` owns
//! session creation for its sign-in routes). Cookie value is `<sid>.<hmac>`
//! where `hmac = HMAC-SHA256(sid, SESSION_SECRET)` in base64url — byte-equal
//! to the WebCrypto signature the TS app produced, so existing sessions keep
//! verifying after the cutover.
//!
//! Cookie attributes mirror hono's serializer:
//! `__Host-tk_sess=<signed>; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`
//! with a 30-day sliding TTL refreshed at most once a day via `ctx.wait_until`.

use trinkhallen_ui::model::{Role, SessionUser};
use worker::{Context, Env, Request, Result};

use crate::crypto::{base64url_encode, hmac_sha256, timing_safe_equal};
use crate::http::{cookie_header, cookie_value, delete_cookie_value};
use crate::util;

pub const COOKIE: &str = "__Host-tk_sess";
pub const TTL_SEC: u32 = 30 * 24 * 60 * 60;

/// `<sid>.<base64url(HMAC-SHA256(sid, SESSION_SECRET))>`.
pub fn sign(sid: &str, secret: &str) -> String {
    let mac = hmac_sha256(secret.as_bytes(), sid.as_bytes());
    format!("{sid}.{}", base64url_encode(&mac))
}

/// Splits at the *last* dot (as the TS verifier did) and compares the MAC
/// in constant time. Returns the sid when the signature is intact.
pub fn verify(signed: &str, secret: &str) -> Option<String> {
    let dot = signed.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let (sid, given) = (&signed[..dot], &signed[dot + 1..]);
    let expected = sign(sid, secret);
    let expected_mac = &expected[dot + 1..];
    timing_safe_equal(given, expected_mac).then(|| sid.to_owned())
}

/// `Set-Cookie` value for a fresh/refreshed session cookie.
pub fn session_cookie(signed: &str) -> String {
    cookie_value(COOKIE, signed, TTL_SEC, "/", true, true, Some("lax"))
}

/// hono `deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true })`.
pub fn clearing_cookie() -> String {
    delete_cookie_value(COOKIE, "/", true)
}

/// Create a session row and return its `Set-Cookie` value. Used by the auth
/// routes after a successful sign-in.
pub async fn create_session(env: &Env, user_id: &str) -> Result<String> {
    let sid = crate::auth::users::uuid_v4().replace('-', "");
    let now = util::now();
    env.d1("DB")?
        .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(&[
            sid.as_str().into(),
            user_id.into(),
            ((now + TTL_SEC as i64) as f64).into(),
            (now as f64).into(),
        ])?
        .run()
        .await?;
    let secret = util::env_str(env, "SESSION_SECRET").unwrap_or_default();
    Ok(session_cookie(&sign(&sid, &secret)))
}

/// Delete the session row behind the request's cookie (if any) and return the
/// clearing `Set-Cookie` value.
pub async fn destroy_session(req: &Request, env: &Env) -> Result<String> {
    let secret = util::env_str(env, "SESSION_SECRET").unwrap_or_default();
    if let Some(raw) = cookie_header(req, COOKIE) {
        if let Some(sid) = verify(&raw, &secret) {
            env.d1("DB")?
                .prepare("DELETE FROM sessions WHERE id = ?")
                .bind(&[sid.as_str().into()])?
                .run()
                .await?;
        }
    }
    Ok(clearing_cookie())
}

#[derive(serde::Deserialize)]
struct SessionRow {
    #[allow(dead_code)]
    sid: String,
    expires_at: f64,
    user_id: String,
    email: String,
    username: Option<String>,
    role: String,
    google_sub: String,
    apple_sub: Option<String>,
}

/// Verify the request's session cookie and load its user, deleting the row
/// when it has expired. Returns the user and any `Set-Cookie` value the
/// response must carry (sliding-TTL refresh).
pub async fn load_session(
    env: &Env,
    req: &Request,
    ctx: &Context,
) -> Result<(Option<SessionUser>, Option<String>)> {
    let Some(raw) = cookie_header(req, COOKIE) else {
        return Ok((None, None));
    };
    let secret = util::env_str(env, "SESSION_SECRET").unwrap_or_default();
    let Some(sid) = verify(&raw, &secret) else {
        return Ok((None, None));
    };

    let db = env.d1("DB")?;
    let row: Option<SessionRow> = crate::db::one(
        &db,
        "SELECT s.id AS sid, s.expires_at AS expires_at,
                  u.id AS user_id, u.email, u.username, u.role,
                  u.google_sub, u.apple_sub
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = ?",
        &[crate::db::Arg::Text(&sid)],
    )
    .await?;
    let Some(row) = row else {
        return Ok((None, None));
    };

    let now = util::now();
    if (row.expires_at as i64) < now {
        db.prepare("DELETE FROM sessions WHERE id = ?")
            .bind(&[sid.as_str().into()])?
            .run()
            .await?;
        return Ok((None, None));
    }

    // Sliding TTL: refresh when the cookie is within a day of expiring. The
    // update runs on `wait_until`; only the re-signed cookie rides the
    // response (same as the TS port).
    let mut refreshed = None;
    if row.expires_at as i64 - now < TTL_SEC as i64 - 24 * 60 * 60 {
        let new_expiry = now + TTL_SEC as i64;
        let sid_for_refresh = sid.clone();
        let refresh_db = env.d1("DB")?;
        ctx.wait_until(async move {
            let bound = refresh_db
                .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
                .bind(&[(new_expiry as f64).into(), sid_for_refresh.as_str().into()]);
            if let Ok(stmt) = bound {
                let _ = stmt.run().await;
            }
        });
        refreshed = Some(session_cookie(&sign(&sid, &secret)));
    }

    // google_sub is NOT NULL UNIQUE, so there is always *something* there; the
    // two synthetic prefixes mark "no real provider link".
    let has_google = !row.google_sub.starts_with("email:") && !row.google_sub.starts_with("apple:");
    let has_apple = row.apple_sub.is_some();
    let user = SessionUser {
        id: row.user_id,
        email: row.email,
        username: row.username,
        role: Role::parse(&row.role),
        is_magic_link_only: !has_google && !has_apple,
        has_google,
        has_apple,
    };
    Ok((Some(user), refreshed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_round_trip() {
        let signed = sign("deadbeefcafebabe", "secret");
        assert!(signed.starts_with("deadbeefcafebabe."));
        assert_eq!(verify(&signed, "secret"), Some("deadbeefcafebabe".into()));
    }

    #[test]
    fn tampered_cookie_rejected() {
        let signed = sign("deadbeefcafebabe", "secret");
        // Flip a MAC character …
        let mut bytes: Vec<u8> = signed.bytes().collect();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'a' { b'b' } else { b'a' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert_eq!(verify(&tampered, "secret"), None);
        // … swap the sid under the same MAC …
        let forged = format!("other.{}", signed.split('.').nth(1).unwrap());
        assert_eq!(verify(&forged, "secret"), None);
        // … use the wrong secret …
        assert_eq!(verify(&signed, "other-secret"), None);
        // … and reject structurally broken input.
        assert_eq!(verify("", "secret"), None);
        assert_eq!(verify(".abc", "secret"), None);
        assert_eq!(verify("nodot", "secret"), None);
    }

    #[test]
    fn cookie_attributes_match_hono() {
        assert_eq!(
            session_cookie("sid.mac"),
            "__Host-tk_sess=sid.mac; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"
        );
        assert_eq!(
            clearing_cookie(),
            "__Host-tk_sess=; Max-Age=0; Path=/; Secure"
        );
    }
}
