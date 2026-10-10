//! HTML rendering entry points used by the Worker.

use dioxus::core::Properties;
use dioxus::prelude::*;
use serde::Serialize;
use trinkhallen_core::Lang;

use crate::model::{Nav, SessionUser};

/// Client bundles a page needs. `App` is always loaded; `Map`/`Pick` add the
/// MapLibre glue and its preconnect/preload hints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientEntry {
    App,
    Map,
    Pick,
}

/// Content-hashed public URLs produced by the build (see the importer).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AssetUrls {
    pub css: Vec<String>,
    pub client_js: String,
    pub client_wasm: String,
    pub map_js: String,
}

/// Everything the document head and chrome need.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub lang: Lang,
    /// Request path; drives hreflang alternates, canonical and the language switcher.
    pub path: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// Absolute canonical URL; query-string variants must not fragment indexing.
    pub canonical_url: Option<String>,
    pub noindex: bool,
    pub json_ld: Vec<serde_json::Value>,
    pub nav: Nav,
    pub entries: Vec<ClientEntry>,
    pub full_bleed: bool,
    pub user: Option<SessionUser>,
    /// Per-request CSP nonce for inline scripts (JSON-LD, speculation rules, bootstrap).
    pub nonce: String,
    pub assets: AssetUrls,
}

impl Page {
    pub fn new(lang: Lang, path: impl Into<String>, nonce: impl Into<String>, assets: AssetUrls) -> Self {
        Page {
            lang,
            path: path.into(),
            title: None,
            description: None,
            canonical_url: None,
            noindex: false,
            json_ld: Vec::new(),
            nav: Nav::Map,
            entries: vec![ClientEntry::App],
            full_bleed: false,
            user: None,
            nonce: nonce.into(),
            assets,
        }
    }
}

/// Render a static component tree (no hydration markers).
pub fn to_html(e: Element) -> String {
    dioxus_ssr::render_element(e)
}

/// Base64 CBOR hydration payload dioxus-web expects in
/// `window.initial_dioxus_hydration_data`: a context holding only the (empty)
/// root error entry — islands carry their data in `data-props`, not in
/// server futures.
pub fn hydration_data() -> String {
    let ctx = dioxus_fullstack_core::HydrationContext::default();
    let none: Option<dioxus::core::CapturedError> = None;
    ctx.error_entry().insert(&none, std::panic::Location::caller());
    ctx.serialized().data
}

/// Escape a string for a single-quoted HTML attribute.
pub fn attr_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('\'', "&#39;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Pre-render a hydratable island. The client finds `[data-island=name]`,
/// deserializes `data-props` into the same props type and hydrates `#root_id`.
pub fn island<P>(root_id: &str, name: &str, component: fn(P) -> Element, props: P) -> String
where
    P: Properties + Serialize + Clone + 'static,
{
    let json = serde_json::to_string(&props).unwrap_or_else(|_| "null".into());
    let mut vdom = VirtualDom::new_with_props(component, props);
    vdom.rebuild_in_place();
    let inner = dioxus_ssr::pre_render(&vdom);
    format!(
        "<div id=\"{root_id}\" data-island=\"{name}\" data-props='{}'>{inner}</div>",
        attr_escape(&json)
    )
}

/// Full HTML document: doctype, head (meta, hreflang, assets, JSON-LD,
/// speculation rules, hydration bootstrap), header chrome, `body` (already
/// rendered main content), footer.
pub fn document(page: &Page, body: String) -> String {
    crate::components::layout::render_document(page, body)
}
