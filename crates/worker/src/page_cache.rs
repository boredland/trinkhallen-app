//! Edge cache for anonymous page renders.
//!
//! Crawlers and logged-out visitors are nearly all page traffic, and a full
//! SSR render costs tens of ms of billed CPU. Their HTML depends only on the
//! path (locale included), the query and the UA bucket (navigate links), so
//! it is shared through `caches.default` for [`TTL_SEC`]. Session holders
//! never touch the cache: their chrome, own ratings and reports are personal.
//!
//! The CSP nonce must stay per-response, so pages render with [`NONCE_SLOT`]
//! and every response — hit or miss — swaps in the request's fresh nonce.
//!
//! Invariant: any new per-request input to an anonymous page (cookie, header,
//! geo) must join [`key`] or make [`cacheable`] return false.

use trinkhallen_core::navigate::UaBucket;
use worker::{Cache, Context, Response, Result};

use crate::http;

/// Open/closed pills and rating counts may lag by this much for anonymous
/// visitors; a deploy reaches them within the same window.
pub const TTL_SEC: u32 = 300;

/// Placeholder nonce baked into cached HTML; base64-shaped so `html_escape`
/// leaves it intact.
pub const NONCE_SLOT: &str = "TkCachedNonceSlot0000==";

/// Locale-stripped page paths whose anonymous render is shared. Auth-gated
/// pages (`/me`, `/add`, `/moderate`) redirect or personalise and stay out.
pub fn cacheable(bare: &str) -> bool {
    matches!(
        bare,
        "/" | "/about" | "/impressum" | "/datenschutz" | "/jetzt"
    ) || bare.starts_with("/k/")
        || bare.starts_with("/stadt/")
}

pub fn key(path: &str, query: &str, ua: UaBucket) -> String {
    format!(
        "https://cache.trinkhallen.app/page{path}?u={}&{query}",
        ua.code()
    )
}

pub fn with_nonce(body: &str, nonce: &str) -> String {
    body.replace(NONCE_SLOT, nonce)
}

pub async fn lookup(key: &str, nonce: &str) -> Result<Option<Response>> {
    let Some(mut hit) = Cache::default().get(key, false).await? else {
        return Ok(None);
    };
    let body = hit.text().await?;
    http::html(with_nonce(&body, nonce), 200).map(Some)
}

/// Fill in the nonce on a render made with [`NONCE_SLOT`], storing it when
/// it is a shareable 200. A response carrying `Set-Cookie` is never stored.
pub async fn finish(
    ctx: &Context,
    key: String,
    mut resp: Response,
    nonce: &str,
) -> Result<Response> {
    let status = resp.status_code();
    if (300..400).contains(&status) {
        return Ok(resp);
    }
    let content_type = resp
        .headers()
        .get("content-type")?
        .unwrap_or_else(|| "text/html; charset=UTF-8".to_owned());
    let body = resp.text().await?;
    if status == 200 && !resp.headers().has("set-cookie")? {
        let cache_control = format!("public, max-age={TTL_SEC}");
        let stored = http::response(
            &content_type,
            body.clone(),
            200,
            &[("cache-control", &cache_control)],
        )?;
        // The cache write never delays the response.
        ctx.wait_until(async move {
            let _ = Cache::default().put(key, stored).await;
        });
    }
    http::response(&content_type, with_nonce(&body, nonce), status, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_pages_bypass_the_cache() {
        for p in ["/me", "/add", "/moderate", "/me/username", "/list"] {
            assert!(!cacheable(p), "{p}");
        }
        for p in ["/", "/k/tk_fr_1", "/stadt/frankfurt", "/about", "/jetzt"] {
            assert!(cacheable(p), "{p}");
        }
    }

    #[test]
    fn key_separates_locale_query_and_ua_bucket() {
        let ios = key("/en/k/x", "partial=1", UaBucket::Ios);
        assert_ne!(ios, key("/k/x", "partial=1", UaBucket::Ios));
        assert_ne!(ios, key("/en/k/x", "", UaBucket::Ios));
        assert_ne!(ios, key("/en/k/x", "partial=1", UaBucket::Other));
    }

    #[test]
    fn every_nonce_slot_gets_the_fresh_nonce() {
        let html = trinkhallen_ui::components::layout::html_escape(NONCE_SLOT);
        assert_eq!(html, NONCE_SLOT);
        let body =
            format!("<script nonce=\"{NONCE_SLOT}\"></script><script nonce=\"{NONCE_SLOT}\">");
        assert_eq!(
            with_nonce(&body, "abc"),
            "<script nonce=\"abc\"></script><script nonce=\"abc\">"
        );
    }
}
