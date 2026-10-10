//! Interactive islands, hydrated by the client crate.
//!
//! Islands reach the browser only through [`Browser`], provided as a Dioxus
//! context by the client. During SSR no handler ever fires, so the server
//! provides nothing and [`browser`] returns `None`.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use dioxus::prelude::*;

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
    /// POST `application/x-www-form-urlencoded` to a same-origin URL.
    fn post_form(&self, url: &str, fields: Vec<(String, String)>) -> BoxFuture<Result<FetchResult, String>>;
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
    /// Read a `data-*` attribute from an element by id.
    fn data_attr(&self, id: &str, name: &str) -> Option<String>;
    /// Write a `data-*` attribute on an element by id.
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
