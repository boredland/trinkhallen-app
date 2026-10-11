//! Google SSO: the OAuth redirect/code-exchange/userinfo steps plus the
//! upsert/link handlers.
//!
//! All three OAuth steps are done here (no provider library) so the
//! fail-closed `state` check from plans/006 sits in front of any network
//! call. Endpoints and parameters match Google's OAuth 2.0 web-server flow.

use worker::{Env, Request, Response, Result};

use super::{
    GOOGLE_STATE_COOKIE, callback_url, check_oauth_state, cookie_header, encode_form, get_bearer,
    post_form, state_cookie, unauthorized, users,
};
use crate::http::{redirect, text};
use crate::session::create_session;
use crate::state::RequestState;
use crate::util::env_str;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPES: &str = "openid email";

const NOT_CONFIGURED_START: &str = "Google SSO is not yet configured on this deployment. The operator needs to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.";
const NOT_CONFIGURED_CALLBACK: &str = "Google SSO is not configured.";
const NO_PROFILE: &str = "Google login did not return a usable profile.";

pub struct GoogleEnv {
    pub client_id: String,
    pub client_secret: String,
}

pub fn google_env(env: &Env) -> Option<GoogleEnv> {
    let client_id = env_str(env, "GOOGLE_CLIENT_ID")?;
    let client_secret = env_str(env, "GOOGLE_CLIENT_SECRET")?;
    Some(GoogleEnv {
        client_id,
        client_secret,
    })
}

fn authorize_url(creds: &GoogleEnv, redirect_uri: &str, state: &str) -> String {
    format!(
        "{AUTH_URL}?{}",
        encode_form(&[
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("client_id", &creds.client_id),
            ("include_granted_scopes", "true"),
            ("scope", SCOPES),
            ("state", state),
        ])
    )
}

/// GET /auth/google — mint the state cookie and hand off to Google.
pub fn start(env: &Env, state: &RequestState) -> Result<Response> {
    let Some(creds) = google_env(env) else {
        return text(NOT_CONFIGURED_START, 503);
    };
    let value = users::uuid_v4();
    let redirect_uri = callback_url(env, state.url.as_str(), "/auth/google/callback");
    let url = authorize_url(&creds, &redirect_uri, &value);
    redirect(
        &url,
        302,
        &[state_cookie(GOOGLE_STATE_COOKIE, &value, "/", "Lax")],
    )
}

/// GET /auth/google/callback.
///
/// Order of checks matters: the `state` comparison happens before the code
/// exchange, so a forged callback — the account-takeover path in plans/006,
/// where link mode attaches whatever Google identity completes the flow —
/// cannot reach the network at all.
pub async fn callback(
    req: Request,
    env: &Env,
    _ctx: &worker::Context,
    state: &RequestState,
) -> Result<Response> {
    let Some(creds) = google_env(env) else {
        return text(NOT_CONFIGURED_CALLBACK, 503);
    };

    let param = query_param(state, "state");
    let cookie = cookie_header(&req, GOOGLE_STATE_COOKIE);
    if !check_oauth_state(param.as_deref(), cookie.as_deref()) {
        return unauthorized();
    }

    let code = match query_param(state, "code") {
        Some(c) if !c.is_empty() => c,
        // The middleware restarted the flow when no code arrived; keep that.
        _ => return start(env, state),
    };

    let redirect_uri = callback_url(env, state.url.as_str(), "/auth/google/callback");
    let body = encode_form(&[
        ("client_id", &creds.client_id),
        ("client_secret", &creds.client_secret),
        ("redirect_uri", &redirect_uri),
        ("code", &code),
        ("grant_type", "authorization_code"),
    ]);
    let mut resp = post_form(TOKEN_URL, &body).await?;
    let token: serde_json::Value = resp.json().await?;
    if token.get("error").is_some() {
        let msg = token
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("Google token exchange failed.");
        return text(msg, 400);
    }
    let access_token = token
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            worker::Error::RustError("google token response has no access_token".into())
        })?
        .to_owned();

    let mut resp = get_bearer(USERINFO_URL, &access_token).await?;
    let profile: serde_json::Value = resp.json().await?;
    if profile.get("error").is_some() {
        let msg = profile
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("Google user info failed.");
        return text(msg, 400);
    }
    let (Some(sub), Some(email)) = (
        profile
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        profile
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    ) else {
        return text(NO_PROFILE, 400);
    };
    let email_verified = profile
        .get("verified_email")
        .and_then(crate::crypto::json_bool_or_str)
        .unwrap_or(false);

    let now = crate::crypto::unix_now();
    let db = env.d1("DB")?;

    // Already logged in and starting Google OAuth from /me → link mode. We
    // trust the current session's identity (verified once via magic-link)
    // and Google's identity (verified just now via OAuth), so attach the
    // Google sub to the existing row regardless of whether the email
    // addresses agree. The two halves of the merge are each independently
    // verified, which is the security invariant that matters.
    if let Some(user) = state.user.as_ref() {
        let linked = users::link_google_to_current_user(&db, &user.id, &sub).await?;
        return if linked {
            redirect("/me?link=ok", 302, &[])
        } else {
            // Google sub is already attached to some *other* row. Refuse to
            // re-point it — the user would need to sign in as that other
            // account first if they want to consolidate.
            redirect("/me?link=conflict", 302, &[])
        };
    }

    let user_id = users::upsert_user_google(&db, &sub, &email, email_verified, now).await?;
    let session = create_session(env, &user_id).await?;
    redirect("/me", 302, &[session])
}

pub fn query_param(state: &RequestState, key: &str) -> Option<String> {
    state
        .url
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_shape_matches_the_library() {
        let creds = GoogleEnv {
            client_id: "cid".into(),
            client_secret: "cs".into(),
        };
        let url = authorize_url(
            &creds,
            "https://trinkhallen.app/auth/google/callback",
            "st4te",
        );
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("include_granted_scopes=true"));
        assert!(url.contains("scope=openid%20email"));
        assert!(url.contains("state=st4te"));
        assert!(
            url.contains("redirect_uri=https%3A%2F%2Ftrinkhallen.app%2Fauth%2Fgoogle%2Fcallback")
        );
    }
}
