//! GitHub helpers outside the App/PR flow.
//!
//! `verify_webhook_signature` follows GitHub's `X-Hub-Signature-256` spec
//! (`sha256=<hex hmac>`); `fetch_raw_file` pulls post-merge file state for
//! the data-sync path.

use worker::Result;

use crate::crypto::{hex_encode, hmac_sha256, timing_safe_equal};

/// Verify a GitHub webhook payload signature.
pub fn verify_webhook_signature(
    raw_body: &str,
    signature_header: Option<&str>,
    secret: &str,
) -> bool {
    let Some(header) = signature_header else {
        return false;
    };
    let Some(provided) = header.strip_prefix("sha256=") else {
        return false;
    };
    let mac = hmac_sha256(secret.as_bytes(), raw_body.as_bytes());
    timing_safe_equal(provided, &hex_encode(&mac))
}

/// Fetch the contents of a file from a public GitHub repo at a specific ref.
pub async fn fetch_raw_file(
    owner: &str,
    repo: &str,
    reference: &str,
    path: &str,
) -> Result<String> {
    let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{reference}/{path}");
    let req = worker::Request::new(&url, worker::Method::Get)?;
    let mut resp = worker::Fetch::Request(req).send().await?;
    if resp.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "GitHub raw fetch {url} failed: HTTP {}",
            resp.status_code()
        )));
    }
    Ok(resp.text().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_signature_matches_the_ts_behaviour() {
        // openssl dgst -sha256 -hmac 'secret' <<< payload
        let body = "payload";
        let mac = hex_encode(&hmac_sha256(b"secret", body.as_bytes()));
        assert!(verify_webhook_signature(
            body,
            Some(&format!("sha256={mac}")),
            "secret"
        ));
        assert!(!verify_webhook_signature(
            body,
            Some(&format!("sha256={mac}")),
            "other"
        ));
        assert!(!verify_webhook_signature(body, Some(&mac), "secret"));
        assert!(!verify_webhook_signature(body, None, "secret"));
        assert!(!verify_webhook_signature(
            body,
            Some("sha256=zzz"),
            "secret"
        ));
    }
}
