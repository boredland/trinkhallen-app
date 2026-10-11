//! Per-request context shared by the router, the page handlers and the
//! auth/moderation slices.
//!
//! The worker fills one [`RequestState`] per fetch before any dispatch; the
//! fields below are the contract the other slices build against.

use trinkhallen_core::Lang;
use trinkhallen_ui::model::SessionUser;
use trinkhallen_ui::render::AssetUrls;

/// Content-hashed asset URLs, resolved once per request from the generated
/// [`crate::assets_manifest`].
pub fn asset_urls() -> AssetUrls {
    AssetUrls {
        css: crate::assets_manifest::CSS
            .iter()
            .map(|c| (*c).to_owned())
            .collect(),
        client_js: crate::assets_manifest::CLIENT_JS.to_owned(),
        client_wasm: crate::assets_manifest::CLIENT_WASM.to_owned(),
        map_js: crate::assets_manifest::MAP_JS.to_owned(),
    }
}

/// Everything a handler needs to know about the request itself.
pub struct RequestState {
    /// Active language from the request path (`/en/…` → `En`, else `De`).
    /// The first-visit redirect middleware runs before any handler, so a
    /// redirected request never reaches one.
    pub lang: Lang,
    /// Session user, if the `__Host-tk_sess` cookie verified and the row is
    /// still alive. The sliding refresh is scheduled on `ctx` while loading.
    pub user: Option<SessionUser>,
    /// Fresh per-request CSP nonce, echoed in the `script-src` header and in
    /// every inline `<script>` the document emits.
    pub nonce: String,
    /// Request origin (`scheme://host`), i.e. `new URL(req.url).origin`. The
    /// CSRF check compares the `Origin` header against it.
    pub origin: String,
    /// The request path as received, including any `/en` prefix. Pages pass
    /// it to `render::Page` for hreflang/canonical/switcher links.
    pub path: String,
    /// Full request URL (path + query) — handlers read query params off it.
    pub url: worker::Url,
    /// Resolved asset URLs for the document head.
    pub assets: AssetUrls,
    /// `User-Agent` header, if the client sent one (drives the navigate
    /// targets and the iOS/Android affordances).
    pub user_agent: Option<String>,
}
