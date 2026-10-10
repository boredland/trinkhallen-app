//! GitHub App client — port of `src/lib/github-app.ts` plus the
//! `authedFetch` helper its sibling `github-pr.ts` grew.
//!
//! Enough to open issues/PRs against `trinkhallen-data` on behalf of the
//! moderators. The App private key arrives as a PEM string in
//! `GITHUB_APP_PRIVATE_KEY`; it is imported per request (Workers reset
//! crypto handles between executions, and caching across requests would
//! need Durable Objects or a KV-stored installation token).

use worker::{Env, Method, Request, Response, Result};

use crate::crypto::{base64url_encode, jwt_signing_input, pem_to_pkcs8_der, sign_pkcs8, unix_now};

pub const GITHUB_API: &str = "https://api.github.com";
pub const USER_AGENT: &str = "trinkhallen-app/1.0";
pub const DATA_REPO_OWNER: &str = "boredland";
pub const DATA_REPO_NAME: &str = "trinkhallen-data";
pub const DEFAULT_BRANCH: &str = "main";

pub struct GithubAppEnv {
    pub app_id: String,
    pub private_key_pem: String,
    pub installation_id: String,
}

pub fn github_app_env(env: &Env) -> Option<GithubAppEnv> {
    Some(GithubAppEnv {
        app_id: crate::auth::secret(env, "GITHUB_APP_ID")?,
        private_key_pem: crate::auth::secret(env, "GITHUB_APP_PRIVATE_KEY")?,
        installation_id: crate::auth::secret(env, "GITHUB_APP_INSTALLATION_ID")?,
    })
}

/// When the App isn't configured, approvals still update D1 (status becomes
/// "approved", pr_url left null) so moderators can act now and PRs get
/// backfilled once the App is provisioned.
pub fn has_github_app_creds(env: &Env) -> bool {
    github_app_env(env).is_some()
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreatedIssue {
    pub number: i64,
    pub html_url: String,
}

/// Authenticated call against the GitHub REST API.
pub async fn authed_fetch(
    token: &str,
    path: &str,
    method: Method,
    body: Option<&str>,
) -> Result<Response> {
    let headers = worker::Headers::new();
    headers.set("accept", "application/vnd.github+json")?;
    headers.set("authorization", &format!("Bearer {token}"))?;
    headers.set("user-agent", USER_AGENT)?;
    headers.set("x-github-api-version", "2022-11-28")?;
    if body.is_some() {
        headers.set("content-type", "application/json")?;
    }
    let mut init = worker::RequestInit::new();
    init.with_method(method);
    init.with_headers(headers);
    if let Some(b) = body {
        init.with_body(Some(wasm_bindgen::JsValue::from_str(b)));
    }
    let req = Request::new_with_init(&format!("{GITHUB_API}{path}"), &init)?;
    worker::Fetch::Request(req).send().await
}

/// POST an issue against the data repo.
pub async fn open_issue(
    env: &Env,
    title: &str,
    body: &str,
    labels: Option<&[String]>,
) -> Result<Option<CreatedIssue>> {
    if !has_github_app_creds(env) {
        return Ok(None);
    }
    let token = get_installation_token(env).await?;
    let mut payload = serde_json::Map::new();
    payload.insert("title".into(), title.into());
    payload.insert("body".into(), body.into());
    if let Some(labels) = labels.filter(|l| !l.is_empty()) {
        payload.insert("labels".into(), labels.to_vec().into());
    }
    let mut resp = authed_fetch(
        &token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/issues"),
        Method::Post,
        Some(&serde_json::Value::Object(payload).to_string()),
    )
    .await?;
    if resp.status_code() != 200 && resp.status_code() != 201 {
        worker::console_error!("GitHub openIssue failed {}", resp.status_code());
        return Ok(None);
    }
    parse_created(&mut resp).await
}

pub async fn parse_created(resp: &mut Response) -> Result<Option<CreatedIssue>> {
    let data: serde_json::Value = resp.json().await?;
    Ok(Some(CreatedIssue {
        number: data.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
        html_url: data
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
    }))
}

pub async fn get_installation_token(env: &Env) -> Result<String> {
    let creds = github_app_env(env).ok_or_else(no_creds)?;
    let app_jwt = mint_app_jwt(&creds.app_id, &creds.private_key_pem, unix_now()).await?;
    let mut resp = authed_fetch(
        &app_jwt,
        &format!("/app/installations/{}/access_tokens", creds.installation_id),
        Method::Post,
        None,
    )
    .await?;
    if resp.status_code() != 200 {
        let status = resp.status_code();
        let body = resp.text().await.unwrap_or_default();
        return Err(worker::Error::RustError(format!(
            "installation token exchange failed {status}: {}",
            body.chars().take(200).collect::<String>()
        )));
    }
    let data: serde_json::Value = resp.json().await?;
    data.get("token")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| worker::Error::RustError("installation token response has no token".into()))
}

/// RS256 JWT identifying the App itself. GitHub caps the lifetime at 10
/// minutes, so 9 minutes with a 60-second clock-skew allowance.
pub async fn mint_app_jwt(app_id: &str, private_key_pem: &str, now: i64) -> Result<String> {
    let header = serde_json::json!({ "alg": "RS256", "typ": "JWT" });
    let claims = serde_json::json!({
        "iat": now - 60,
        "exp": now + 9 * 60,
        "iss": app_id,
    });
    let signing_input = jwt_signing_input(&header, &claims);
    let der = pem_to_pkcs8_der(private_key_pem).ok_or_else(|| {
        worker::Error::RustError("GITHUB_APP_PRIVATE_KEY is not valid PEM".into())
    })?;
    let sig = sign_pkcs8("RS256", &der, signing_input.as_bytes())
        .await
        .map_err(|e| worker::Error::RustError(format!("app jwt sign failed: {e:?}")))?;
    Ok(format!("{signing_input}.{}", base64url_encode(&sig)))
}

fn no_creds() -> worker::Error {
    worker::Error::RustError("GitHub App credentials not configured".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{base64url_decode, jwt_decode_payload};

    #[test]
    fn app_jwt_header_and_claims() {
        // The signature needs WebCrypto (unavailable in native tests); the
        // signing input is everything the signature covers and is pure.
        let header = serde_json::json!({ "alg": "RS256", "typ": "JWT" });
        let claims = serde_json::json!({ "iat": 1000 - 60, "exp": 1000 + 9 * 60, "iss": "42" });
        let input = jwt_signing_input(&header, &claims);
        let mut parts = input.split('.');
        let h = base64url_decode(parts.next().unwrap()).unwrap();
        let h: serde_json::Value = serde_json::from_slice(&h).unwrap();
        assert_eq!(h["alg"], "RS256");
        assert_eq!(h["typ"], "JWT");
        let payload = jwt_decode_payload(&format!("{input}.c2ln")).unwrap();
        assert_eq!(payload["iat"], 940);
        assert_eq!(payload["exp"], 1540);
        assert_eq!(payload["iss"], "42");
    }
}
