//! Interactive islands, hydrated by the client crate.
//!
//! Islands reach the browser only through [`Browser`], provided as a Dioxus
//! context by the client. During SSR no handler ever fires, so the server
//! provides nothing and [`browser`] returns `None`.
//!
//! Every island has a serde-serializable props struct (so the server can ship
//! it as `data-props`), a component `fn(Props) -> Element` and a `NAME`
//! constant. [`hydrate_by_name`] rebuilds the VirtualDom on the client from
//! the serialized props — the reverse of [`crate::render::island`], which is
//! what emitted the markup being hydrated.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use dioxus::core::{Element, Properties, VirtualDom};
use dioxus::prelude::*;
use serde::Serialize;

pub mod checkin;
pub mod filters;
pub mod rating;
pub mod report;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T>>>;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Coords {
    pub lat: f64,
    pub lng: f64,
    pub accuracy: f64,
}

/// HTTP response as islands see it.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchResult {
    pub status: u16,
    pub body: String,
}

pub trait BrowserApi {
    /// POST `application/x-www-form-urlencoded` to a same-origin URL with
    /// `X-Tk-Fragment: 1` and `accept: text/html`, so `/api/*` handlers answer
    /// with the HTML fragment the island swaps in.
    fn post_form(
        &self,
        url: &str,
        fields: Vec<(String, String)>,
    ) -> BoxFuture<Result<FetchResult, String>>;
    /// GET a same-origin URL (text body).
    fn get_text(&self, url: &str) -> BoxFuture<Result<FetchResult, String>>;
    /// Best-effort high-accuracy geolocation; `None` on denial/timeout/unsupported.
    fn geolocate(&self) -> BoxFuture<Option<Coords>>;
    /// `history.replaceState` to a new URL (path + query).
    fn replace_url(&self, url: &str);
    /// Current `location.pathname + location.search`.
    fn current_url(&self) -> String;
    /// `window.dispatchEvent(new CustomEvent(name, { detail }))`; `detail` is JSON.
    fn dispatch(&self, name: &str, detail_json: &str);
    /// Replace the inner HTML of an element by id (server-rendered fragments).
    fn set_inner_html(&self, id: &str, html: &str);
    /// Replace the element itself (`element.outerHTML = html`); the fragment
    /// carries a root with the same id, so later swaps still find it.
    fn set_outer_html(&self, id: &str, html: &str);
    /// `document.querySelector(selector)?.scrollIntoView({ block: "nearest" })`.
    fn scroll_into_view(&self, selector: &str);
    /// `setTimeout`-backed delay (`ms`), used for the filter debounce.
    fn sleep_ms(&self, ms: u32) -> BoxFuture<()>;
    /// Read a `data-*` attribute from an element by id. `name` is the
    /// attribute name without the `data-` prefix, hyphenated (`data-panel-url`
    /// → `"panel-url"`).
    fn data_attr(&self, id: &str, name: &str) -> Option<String>;
    /// Write a `data-*` attribute on an element by id (same naming as
    /// [`BrowserApi::data_attr`]).
    fn set_data_attr(&self, id: &str, name: &str, value: &str);
}

#[derive(Clone)]
pub struct Browser(pub Rc<dyn BrowserApi>);

impl PartialEq for Browser {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// The browser bridge when running hydrated in the client; `None` during SSR.
pub fn browser() -> Option<Browser> {
    try_consume_context::<Browser>()
}

/// Rebuild the VirtualDom for a named island from its serialized props.
///
/// This is the client-side counterpart of [`crate::render::island`]: the
/// server pre-renders the component into `[data-island]` with `data-props`,
/// the client calls this and hydrates the returned dom onto that element.
/// Unknown names (or props that do not parse) yield `None`.
pub fn hydrate_by_name(name: &str, props_json: &str) -> Option<VirtualDom> {
    fn build<P>(component: fn(P) -> Element, props_json: &str) -> Option<VirtualDom>
    where
        P: Properties + Serialize + serde::de::DeserializeOwned + Clone + 'static,
    {
        let props: P = serde_json::from_str(props_json).ok()?;
        Some(VirtualDom::new_with_props(component, props))
    }
    match name {
        filters::NAME => build(filters::FilterIsland, props_json),
        rating::NAME => build(rating::RatingIsland, props_json),
        checkin::NAME => build(checkin::CheckinIsland, props_json),
        report::NAME => build(report::ReportIsland, props_json),
        _ => None,
    }
}

/// Every island name, for client-side discovery and tests.
pub const NAMES: [&str; 4] = [filters::NAME, rating::NAME, checkin::NAME, report::NAME];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_round_trips_all_islands() {
        for name in NAMES {
            let props = match name {
                filters::NAME => serde_json::to_string(&filters::FilterProps::sample()).unwrap(),
                rating::NAME => serde_json::to_string(&rating::RatingProps::sample()).unwrap(),
                checkin::NAME => serde_json::to_string(&checkin::CheckinProps::sample()).unwrap(),
                report::NAME => serde_json::to_string(&report::ReportProps::sample()).unwrap(),
                _ => unreachable!(),
            };
            assert!(
                hydrate_by_name(name, &props).is_some(),
                "island {name} must hydrate from JSON"
            );
        }
    }

    #[test]
    fn unknown_island_is_none() {
        assert!(hydrate_by_name("nope", "{}").is_none());
        assert!(hydrate_by_name(rating::NAME, "{not json").is_none());
    }
}
