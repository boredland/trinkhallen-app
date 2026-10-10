//! Browser bridge for the islands (`trinkhallen_ui::islands::BrowserApi`).
//!
//! Everything the islands do to the page goes through here so the same
//! components run unchanged under SSR (where [`Browser`] is absent).

use std::rc::Rc;

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;

use trinkhallen_ui::islands::{BoxFuture, Browser, BrowserApi, Coords, FetchResult};

use crate::dom;
use crate::net;

/// The web-sys implementation, provided as root context to every island
/// VirtualDom.
pub struct WebBrowser;

impl BrowserApi for WebBrowser {
    fn post_form(
        &self,
        url: &str,
        fields: Vec<(String, String)>,
    ) -> BoxFuture<Result<FetchResult, String>> {
        let url = url.to_owned();
        Box::pin(async move {
            let res = net::post_form(&url, fields).await?;
            Ok(FetchResult {
                status: res.status,
                body: res.body,
            })
        })
    }

    fn get_text(&self, url: &str) -> BoxFuture<Result<FetchResult, String>> {
        let url = url.to_owned();
        Box::pin(async move {
            let res = net::get_text(&url, "text/html").await?;
            Ok(FetchResult {
                status: res.status,
                body: res.body,
            })
        })
    }

    fn geolocate(&self) -> BoxFuture<Option<Coords>> {
        Box::pin(crate::geo::geolocate())
    }

    fn sleep_ms(&self, ms: u32) -> BoxFuture<()> {
        Box::pin(async move {
            let (tx, rx) = futures_channel::oneshot::channel();
            crate::dom::set_timeout(
                move || {
                    let _ = tx.send(());
                },
                ms as i32,
            );
            let _ = rx.await;
        })
    }

    fn replace_url(&self, url: &str) {
        dom::replace_state(url);
    }

    fn current_url(&self) -> String {
        format!("{}{}", dom::location_pathname(), dom::location_search())
    }

    fn dispatch(&self, name: &str, detail_json: &str) {
        let detail = js_sys::JSON::parse(detail_json).unwrap_or(JsValue::NULL);
        dom::dispatch(name, &detail);
    }

    fn set_inner_html(&self, id: &str, html: &str) {
        if let Some(el) = dom::document().get_element_by_id(id) {
            dom::inner_html(&el, html);
            crate::startup::hydrate_pending(&el);
        }
    }

    fn set_outer_html(&self, id: &str, html: &str) {
        // The fragment carries a root with the same id, so a later swap finds
        // it again. It may also carry fresh island markup — the running
        // VirtualDom loses its host element here, so the replacement is
        // hydrated as a new island root.
        if let Some(el) = dom::document().get_element_by_id(id) {
            el.set_outer_html(html);
            if let Some(parent) = dom::document()
                .get_element_by_id(id)
                .and_then(|e| e.parent_element())
            {
                crate::startup::hydrate_pending(&parent);
            }
        }
    }

    fn data_attr(&self, id: &str, name: &str) -> Option<String> {
        dom::document()
            .get_element_by_id(id)
            .and_then(|el| dom::data_attr(&el, name))
    }

    fn set_data_attr(&self, id: &str, name: &str, value: &str) {
        if let Some(el) = dom::document().get_element_by_id(id) {
            dom::set_data_attr(&el, name, value);
        }
    }

    fn scroll_into_view(&self, selector: &str) {
        for el in dom::query_doc(selector) {
            if let Some(el) = el.dyn_ref::<web_sys::HtmlElement>() {
                let _ = el.scroll_into_view_with_scroll_into_view_options(&scroll_opts());
                return;
            }
        }
    }
}

fn scroll_opts() -> web_sys::ScrollIntoViewOptions {
    let o = web_sys::ScrollIntoViewOptions::new();
    o.set_block(web_sys::ScrollLogicalPosition::Nearest);
    o
}

/// The shared bridge instance (`Rc`, so every island root sees the same one).
pub fn browser() -> Browser {
    Browser(Rc::new(WebBrowser))
}

/// Rebuild a VirtualDom for a server-rendered island from its `data-props`
/// (the registry in `trinkhallen_ui::islands` owns the name → component map).
pub fn hydrate_island(name: &str, props_json: &str) -> Option<dioxus::core::VirtualDom> {
    trinkhallen_ui::islands::hydrate_by_name(name, props_json)
}
