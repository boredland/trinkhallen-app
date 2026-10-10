//! Sign in with Apple, including the `/auth/apple*` routes.
//!
//! Apple's OAuth flow differs from Google's in three ways, all reflected
//! here: the callback is a cross-site `form_post` (→ `SameSite=None` state
//! cookie), the `client_secret` is a short-lived ES256 JWT signed with the
//! `.p8` key (minted per exchange), and the id_token payload carries `sub`
//! and `email` directly.

use worker::{Env, Request, Response, Result};

use super::{
    APPLE_STATE_COOKIE, callback_url, check_oauth_state, clear_cookie, cookie_header, encode_form,
    post_form, state_cookie, users,
};
use crate::crypto::{
    base64url_encode, json_bool_or_str, jwt_decode_payload, jwt_signing_input, pem_to_pkcs8_der,
    sign_pkcs8, unix_now,
};
use crate::http::{redirect, text};
use crate::session::create_session;
use crate::state::RequestState;
use crate::util::env_str;

const APPLE_AUDIENCE: &str = "https://appleid.apple.com";
const TOKEN_URL: &str = "https://appleid.apple.com/auth/token";
const AUTH_URL: &str = "https://appleid.apple.com/auth/authorize";

const NOT_CONFIGURED_START: &str = "Apple SSO is not yet configured on this deployment. The operator needs to set APPLE_SIGN_IN_{SERVICES_ID,TEAM_ID,KEY_ID,PRIVATE_KEY}.";
const NOT_CONFIGURED_CALLBACK: &str = "Apple SSO is not configured.";

pub struct AppleEnv {
    pub services_id: String,
    pub team_id: String,
    pub key_id: String,
    pub private_key_pem: String,
}

/// The four secrets together, or `None` so callers can short-circuit with a
/// "not configured" message instead of failing deep in the JWT signer.
pub fn apple_env(env: &Env) -> Option<AppleEnv> {
    Some(AppleEnv {
        services_id: env_str(env, "APPLE_SIGN_IN_SERVICES_ID")?,
        team_id: env_str(env, "APPLE_SIGN_IN_TEAM_ID")?,
        key_id: env_str(env, "APPLE_SIGN_IN_KEY_ID")?,
        private_key_pem: env_str(env, "APPLE_SIGN_IN_PRIVATE_KEY")?,
    })
}

fn authorize_url(apple: &AppleEnv, redirect_uri: &str, state: &str) -> String {
    // `response_mode=form_post` is mandatory whenever an `email` scope is
    // requested; query-string mode strips it. The trade-off is the cross-site
    // POST, which requires the SameSite=None state cookie set by [`start`].
    format!(
        "{AUTH_URL}?{}",
        encode_form(&[
            ("client_id", &apple.services_id),
            ("redirect_uri", redirect_uri),
            ("response_type", "code"),
            ("response_mode", "form_post"),
            ("scope", "email"),
            ("state", state),
        ])
    )
}

/// GET /auth/apple.
pub fn start(env: &Env, state: &RequestState) -> Result<Response> {
    let Some(apple) = apple_env(env) else {
        return text(NOT_CONFIGURED_START, 503);
    };
    let value = users::uuid_v4();
    // SameSite=None so the cookie survives Apple's cross-site POST back to
    // /auth/apple/callback. HttpOnly + Secure to keep the value out of JS
    // and off plaintext networks.
    let cookie = state_cookie(APPLE_STATE_COOKIE, &value, "/auth/apple", "None");
    let redirect_uri = callback_url(env, state.url.as_str(), "/auth/apple/callback");
    let url = authorize_url(&apple, &redirect_uri, &value);
    redirect(&url, 302, &[cookie])
}

/// POST /auth/apple/callback.
pub async fn callback(
    mut req: Request,
    env: &Env,
    _ctx: &worker::Context,
    state: &RequestState,
) -> Result<Response> {
    let Some(apple) = apple_env(env) else {
        return text(NOT_CONFIGURED_CALLBACK, 503);
    };

    let form = req.form_data().await?;
    let form_state = form.get_field("state");
    let code = form.get_field("code").unwrap_or_default();
    let error = form.get_field("error");
    let clear = clear_cookie(APPLE_STATE_COOKIE, "/auth/apple");

    if let Some(err) = error {
        return text_with_cookies(&format!("Apple sign-in error: {err}"), 400, &[clear]);
    }
    if code.is_empty() {
        return text_with_cookies(
            "Apple sign-in did not return an authorization code.",
            400,
            &[clear],
        );
    }

    // CSRF: the state in Apple's POST body must match the one we set in the
    // cookie when redirecting. One-shot — clear it either way.
    let expected = cookie_header(&req, APPLE_STATE_COOKIE);
    if !check_oauth_state(form_state.as_deref(), expected.as_deref()) {
        return text_with_cookies(
            "Apple sign-in state mismatch (possible CSRF).",
            400,
            &[clear],
        );
    }

    let redirect_uri = callback_url(env, state.url.as_str(), "/auth/apple/callback");
    let id_token = match exchange_code(&apple, &code, &redirect_uri).await {
        Ok(t) => t,
        Err(e) => {
            worker::console_error!("apple token exchange failed: {e}");
            return text_with_cookies("Apple sign-in could not exchange the code.", 502, &[clear]);
        }
    };

    let Some(sub) = id_token.sub.filter(|s| !s.is_empty()) else {
        return text_with_cookies("Apple sign-in returned no user identifier.", 400, &[clear]);
    };
    // No email means the user denied the email scope. We can't create an
    // account without one (magic-link + future contact rely on it).
    let Some(email) = id_token.email.filter(|e| !e.is_empty()) else {
        return text_with_cookies(
            "Apple sign-in returned no email. Re-enable 'Share My Email' on the next try.",
            400,
            &[clear],
        );
    };

    let now = unix_now();
    let db = env.d1("DB")?;

    if let Some(user) = state.user.as_ref() {
        let linked = users::link_apple_to_current_user(&db, &user.id, &sub).await?;
        return if linked {
            redirect("/me?link=ok", 302, &[clear])
        } else {
            redirect("/me?link=conflict", 302, &[clear])
        };
    }

    let user_id = users::upsert_user_apple(&db, &sub, &email, id_token.email_verified, now).await?;
    let session = create_session(env, &user_id).await?;
    redirect("/me", 302, &[clear, session])
}

pub struct AppleIdToken {
    pub sub: Option<String>,
    pub email: Option<String>,
    /// Apple encodes this as a boolean or the strings "true"/"false".
    pub email_verified: bool,
}

/// Exchanges the authorization code Apple POSTed to us for an id_token we
/// can trust. Returns the decoded payload.
pub async fn exchange_code(
    apple: &AppleEnv,
    code: &str,
    redirect_uri: &str,
) -> Result<AppleIdToken> {
    let client_secret = mint_client_secret(apple).await?;
    let body = encode_form(&[
        ("client_id", &apple.services_id),
        ("client_secret", &client_secret),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ]);
    let mut resp = post_form(TOKEN_URL, &body).await?;
    if resp.status_code() != 200 {
        let status = resp.status_code();
        let body = resp.text().await.unwrap_or_default();
        return Err(worker::Error::RustError(format!(
            "apple /auth/token returned {status}: {}",
            body.chars().take(200).collect::<String>()
        )));
    }
    let json: serde_json::Value = resp.json().await?;
    let Some(jwt) = json.get("id_token").and_then(|v| v.as_str()) else {
        return Err(worker::Error::RustError(
            "apple /auth/token returned no id_token".into(),
        ));
    };
    let payload = jwt_decode_payload(jwt).map_err(worker::Error::RustError)?;
    Ok(AppleIdToken {
        sub: payload
            .get("sub")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        email: payload
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        email_verified: payload
            .get("email_verified")
            .and_then(json_bool_or_str)
            .unwrap_or(false),
    })
}

/// The JWT header and claims for Apple's `client_secret`, as JSON so the
/// shape is testable without WebCrypto.
pub fn client_secret_parts(apple: &AppleEnv, now: i64) -> (serde_json::Value, serde_json::Value) {
    let header = serde_json::json!({ "alg": "ES256", "kid": apple.key_id, "typ": "JWT" });
    let claims = serde_json::json!({
        "iss": apple.team_id,
        "iat": now,
        "exp": now + 300,
        "aud": APPLE_AUDIENCE,
        "sub": apple.services_id,
    });
    (header, claims)
}

/// The ES256 JWT we use as `client_secret`. Lifetime is 5 minutes — well
/// under Apple's 6-month max but plenty for the one round-trip.
pub async fn mint_client_secret(apple: &AppleEnv) -> Result<String> {
    let der = pem_to_pkcs8_der(&apple.private_key_pem)
        .ok_or_else(|| worker::Error::RustError("apple private key is not valid PEM".into()))?;
    let now = unix_now();
    let (header, claims) = client_secret_parts(apple, now);
    let signing_input = jwt_signing_input(&header, &claims);
    let sig = sign_pkcs8("ES256", &der, signing_input.as_bytes())
        .await
        .map_err(|e| worker::Error::RustError(format!("apple client_secret sign failed: {e:?}")))?;
    Ok(format!("{signing_input}.{}", base64url_encode(&sig)))
}

fn text_with_cookies(body: &str, status: u16, cookies: &[String]) -> Result<Response> {
    let resp = text(body, status)?;
    for c in cookies {
        resp.headers().append("Set-Cookie", c)?;
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_token_payload_decoding() {
        let payload = br#"{"sub":"abc","email":"a@b.de","email_verified":"true"}"#;
        let jwt = format!("aHBo.{}.c2ln", base64url_encode(payload));
        let t = jwt_decode_payload(&jwt).unwrap();
        assert_eq!(t["sub"], "abc");
        assert_eq!(json_bool_or_str(&t["email_verified"]), Some(true));
    }

    #[test]
    fn client_secret_header_and_claims() {
        let apple = AppleEnv {
            services_id: "svc".into(),
            team_id: "team".into(),
            key_id: "key".into(),
            private_key_pem: String::new(),
        };
        let (header, claims) = client_secret_parts(&apple, 1_000);
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "key");
        assert_eq!(header["typ"], "JWT");
        assert_eq!(claims["iss"], "team");
        assert_eq!(claims["sub"], "svc");
        assert_eq!(claims["aud"], "https://appleid.apple.com");
        assert_eq!(claims["iat"], 1_000);
        assert_eq!(claims["exp"], 1_300);
    }

    #[test]
    fn authorize_url_shape() {
        let apple = AppleEnv {
            services_id: "svc".into(),
            team_id: "team".into(),
            key_id: "key".into(),
            private_key_pem: String::new(),
        };
        let url = authorize_url(
            &apple,
            "https://trinkhallen.app/auth/apple/callback",
            "st4te",
        );
        assert!(url.starts_with("https://appleid.apple.com/auth/authorize?"));
        assert!(url.contains("response_mode=form_post"));
        assert!(url.contains("scope=email"));
        assert!(url.contains("state=st4te"));
        assert!(url.contains("client_id=svc"));
    }
}
