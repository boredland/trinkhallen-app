//! Tiny web-sys helpers shared by the behaviour modules.

use js_sys::Reflect;
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::wasm_bindgen;
use web_sys::{
    CustomEvent, CustomEventInit, Document, Element, Event, EventTarget, HtmlElement, Window,
};

#[wasm_bindgen]
unsafe extern "C" {
    /// `CustomEvent`, typed so `detail` reads back as a plain JS value.
    #[wasm_bindgen(extends = EventTarget, extends = js_sys::Object, js_name = CustomEvent, typescript_type = "CustomEvent")]
    pub type JsCustomEvent;

    #[wasm_bindgen(method, getter)]
    pub fn detail(this: &JsCustomEvent) -> JsValue;
}

pub fn window() -> Window {
    web_sys::window().expect("trinkhallen-client runs in a window")
}

pub fn document() -> Document {
    window().document().expect("document missing")
}

pub fn body() -> HtmlElement {
    document().body().expect("body missing")
}

/// Language the document claims, normalized to the two supported codes.
pub fn doc_lang() -> trinkhallen_core::Lang {
    let lang = document()
        .document_element()
        .and_then(|e| e.get_attribute("lang"));
    trinkhallen_core::i18n::resolve_lang(lang.as_deref())
}

/// Locale-neutral path (the `/en` prefix stripped), for path-shape checks.
pub fn bare_pathname() -> String {
    trinkhallen_core::i18n::path_for_lang(
        &location_pathname(),
        trinkhallen_core::i18n::DEFAULT_LANG,
    )
}

pub fn location() -> web_sys::Location {
    window().location()
}

pub fn location_pathname() -> String {
    location().pathname().unwrap_or_default()
}

pub fn location_search() -> String {
    location().search().unwrap_or_default()
}

pub fn location_href() -> String {
    location().href().unwrap_or_default()
}

pub fn location_origin() -> String {
    location().origin().unwrap_or_default()
}

pub fn replace_state(url: &str) {
    if let Ok(h) = window().history() {
        let _ = h.replace_state_with_url(&JsValue::NULL, "", Some(url));
    }
}

pub fn push_state(url: &str) {
    if let Ok(h) = window().history() {
        let _ = h.push_state_with_url(&JsValue::NULL, "", Some(url));
    }
}

pub fn history_back() {
    if let Ok(h) = window().history() {
        let _ = h.back();
    }
}

pub fn history_length() -> u32 {
    window()
        .history()
        .map(|h| h.length().unwrap_or(0))
        .unwrap_or(0)
}

/// `window.dispatchEvent(new CustomEvent(name, { detail }))`.
pub fn dispatch(name: &str, detail: &JsValue) {
    let init = CustomEventInit::new();
    init.set_detail(detail);
    init.set_cancelable(true);
    if let Ok(ev) = CustomEvent::new_with_event_init_dict(name, &init) {
        let _ = window().dispatch_event(&ev);
    }
}

/// First element's `data-<name>` value; `name` may be given in either
/// `panel-url` (attribute form) or `panelUrl` (dataset form).
pub fn data_attr(el: &Element, name: &str) -> Option<String> {
    el.get_attribute(&data_attr_name(name))
        .filter(|v| !v.is_empty())
}

pub fn set_data_attr(el: &Element, name: &str, value: &str) {
    let _ = el.set_attribute(&data_attr_name(name), value);
}

fn data_attr_name(name: &str) -> String {
    if name.starts_with("data-") {
        name.to_owned()
    } else {
        format!("data-{}", kebab(name))
    }
}

/// `fooBar` → `foo-bar` (dataset key → attribute name); kebab input is kept.
fn kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

pub fn inner_html(el: &Element, html: &str) {
    el.set_inner_html(html);
}

/// URL query string (`?a=1&b=2`) as decoded key/value pairs.
pub fn for_each_query(search: &str, mut f: impl FnMut(&str, &str)) {
    for pair in search
        .trim_start_matches('?')
        .split('&')
        .filter(|p| !p.is_empty())
    {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        f(&decode(k), &decode(v));
    }
}

/// Like `URLSearchParams.get`: first value for a key, `None` when absent.
pub fn query_get(search: &str, key: &str) -> Option<String> {
    let mut found = None;
    for_each_query(search, |k, v| {
        if found.is_none() && k == key {
            found = Some(v.to_owned());
        }
    });
    found
}

/// Query string from pairs (`URLSearchParams.toString()`).
pub fn query_string(pairs: &[(String, String)]) -> String {
    let params = web_sys::UrlSearchParams::new().expect("UrlSearchParams");
    for (k, v) in pairs {
        params.append(k, v);
    }
    params.to_string().into()
}

fn decode(s: &str) -> String {
    js_sys::decode_uri_component(s)
        .map(|s| s.into())
        .unwrap_or_else(|_| s.to_owned())
}

/// Rewrite the query of `base_url` (relative hrefs resolve against the page
/// origin, like `new URL(href, location.origin)`): `Some` sets/replaces keys
/// (`None` deletes), then `remove` deletes keys. Returns path + query, ready
/// for `history.replaceState`.
pub fn rewrite_query(
    base_url: &str,
    set: &[(&str, Option<&str>)],
    remove: &[&str],
) -> Option<String> {
    let url = web_sys::Url::new_with_base(base_url, &location_origin()).ok()?;
    let params = url.search_params();
    for (k, v) in set {
        match v {
            Some(v) => params.set(k, v),
            None => {
                let _ = params.delete(k);
            }
        }
    }
    for k in remove {
        let _ = params.delete(k);
    }
    Some(format!("{}{}", url.pathname(), url.search()))
}

pub fn query_all(root: &Element, sel: &str) -> Vec<Element> {
    root.query_selector_all(sel)
        .map(collect)
        .unwrap_or_default()
}

pub fn query_doc(sel: &str) -> Vec<Element> {
    document()
        .query_selector_all(sel)
        .map(collect)
        .unwrap_or_default()
}

pub fn query_one(root: &Element, sel: &str) -> Option<Element> {
    root.query_selector(sel).ok().flatten()
}

pub fn collect(list: web_sys::NodeList) -> Vec<Element> {
    let mut out = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        if let Some(el) = list.get(i).and_then(|n| n.dyn_into::<Element>().ok()) {
            out.push(el);
        }
    }
    out
}

/// Add an event listener and forget the closure (page-lifetime wiring).
pub fn on(target: &EventTarget, name: &str, f: impl FnMut(Event) + 'static) {
    let cb = Closure::<dyn FnMut(Event)>::new(f);
    let _ = target.add_event_listener_with_callback(name, cb.as_ref().unchecked_ref());
    cb.forget();
}

/// Generic listener closure for non-`Event` payloads (pointer, message).
pub fn js_closure<T>(f: impl FnMut(T) + 'static) -> Closure<dyn FnMut(T)>
where
    T: wasm_bindgen::convert::FromWasmAbi + 'static,
{
    Closure::<dyn FnMut(T)>::new(f)
}

/// `setTimeout` that returns the handle (for cancellable timers).
pub fn set_timeout_id(f: impl FnOnce() + 'static, ms: i32) -> i32 {
    let cb = Closure::once_into_js(f);
    let cb: &js_sys::Function = cb.unchecked_ref();
    window()
        .set_timeout_with_callback_and_timeout_and_arguments_0(cb, ms)
        .unwrap_or(-1)
}

pub fn set_timeout(f: impl FnOnce() + 'static, ms: i32) {
    set_timeout_id(f, ms);
}

pub fn clear_timeout(id: i32) {
    let _ = window().clear_timeout_with_handle(id);
}

pub fn read_property(obj: &JsValue, key: &str) -> JsValue {
    Reflect::get(obj, &JsValue::from_str(key)).unwrap_or(JsValue::NULL)
}

pub fn read_string(obj: &JsValue, key: &str) -> Option<String> {
    read_property(obj, key)
        .as_string()
        .filter(|s| !s.is_empty())
}

pub fn read_number(obj: &JsValue, key: &str) -> Option<f64> {
    read_property(obj, key).as_f64()
}

pub fn local_storage() -> Option<web_sys::Storage> {
    window().local_storage().ok().flatten()
}

pub fn match_media(query: &str) -> bool {
    window()
        .match_media(query)
        .ok()
        .flatten()
        .map(|m| m.matches())
        .unwrap_or(false)
}

pub fn console_error(msg: &str) {
    web_sys::console::error_1(&JsValue::from_str(msg));
}
