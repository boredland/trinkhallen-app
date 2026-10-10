//! Same-origin fetches and JSON decoding.

use serde_json::Value;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestCredentials, RequestInit, RequestRedirect, Response};

use crate::dom::JsCustomEvent;

/// One form field of an `application/x-www-form-urlencoded` POST body.
pub type Field = (String, String);

/// Response as the islands see it: status + text body.
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub status: u16,
    pub body: String,
}

/// POST `application/x-www-form-urlencoded`, same-origin cookies, and the
/// `X-Tk-Fragment: 1` flag the rating/report handlers branch on.
pub async fn post_form(url: &str, fields: Vec<Field>) -> Result<FetchResult, String> {
    let body = urlencoded(&fields);
    let init = RequestInit::new();
    init.set_method("POST");
    init.set_body(&wasm_bindgen::JsValue::from_str(&body));
    init.set_credentials(RequestCredentials::SameOrigin);
    init.set_redirect(RequestRedirect::Manual);
    let req = Request::new_with_str_and_init(url, &init).map_err(js_err)?;
    req.headers()
        .set("content-type", "application/x-www-form-urlencoded")
        .map_err(js_err)?;
    req.headers().set("x-tk-fragment", "1").map_err(js_err)?;
    send(req).await
}

/// GET a text body (HTML partials, JSON) with the browser cache semantics the
/// TS client had (`fetch(url, { headers: { accept } })`).
pub async fn get_text(url: &str, accept: &str) -> Result<FetchResult, String> {
    let init = RequestInit::new();
    init.set_method("GET");
    init.set_credentials(RequestCredentials::SameOrigin);
    let req = Request::new_with_str_and_init(url, &init).map_err(js_err)?;
    req.headers().set("accept", accept).map_err(js_err)?;
    send(req).await
}

/// GET + JSON parse; `None` on a non-2xx response (the region store treats a
/// failed load as "no data this time", never fatal).
pub async fn get_json(url: &str) -> Option<Value> {
    let res = get_text(url, "application/json").await.ok()?;
    if !(200..300).contains(&res.status) {
        return None;
    }
    serde_json::from_str(&res.body).ok()
}

#[wasm_bindgen]
unsafe extern "C" {
    #[wasm_bindgen(js_name = fetch, catch)]
    fn fetch_request(req: Request) -> Result<js_sys::Promise, wasm_bindgen::JsValue>;
}

async fn send(req: Request) -> Result<FetchResult, String> {
    let promise = fetch_request(req).map_err(js_err)?;
    let resp = JsFuture::from(promise).await.map_err(js_err)?;
    let resp: Response = resp.dyn_into().map_err(js_err)?;
    let status = resp.status();
    let body = JsFuture::from(resp.text().map_err(js_err)?)
        .await
        .map_err(js_err)?;
    Ok(FetchResult {
        status,
        body: body.as_string().unwrap_or_default(),
    })
}

fn js_err(e: wasm_bindgen::JsValue) -> String {
    e.as_string().unwrap_or_else(|| "fetch failed".to_owned())
}

/// `application/x-www-form-urlencoded` body, spaces as `+` (HTML form
/// submission encoding) so the Worker's form parser sees identical bytes to
/// a real `<form>` POST.
pub fn urlencoded(fields: &[Field]) -> String {
    fields
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b' ' => out.push('+'),
            b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Serialize the named fields of a form (`new FormData(form)` in the TS app).
pub fn form_fields(form: &web_sys::HtmlFormElement) -> Vec<Field> {
    let mut out = Vec::new();
    for el in crate::dom::query_all(form, "[name]") {
        let name = match el.get_attribute("name") {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        if let Some(input) = el.dyn_ref::<web_sys::HtmlInputElement>() {
            let ty = input.type_();
            match ty.as_str() {
                "checkbox" | "radio" => {
                    if input.checked() {
                        out.push((name, input.value()));
                    }
                }
                "submit" | "button" | "reset" | "file" => {}
                _ => out.push((name, input.value())),
            }
        } else if let Some(sel) = el.dyn_ref::<web_sys::HtmlSelectElement>() {
            out.push((name, sel.value()));
        } else if let Some(ta) = el.dyn_ref::<web_sys::HtmlTextAreaElement>() {
            out.push((name, ta.value()));
        }
    }
    out
}

/// Event `detail` as a JSON value (`{…}` CustomEvents from map.js / islands).
pub fn event_detail(ev: &web_sys::Event) -> Option<Value> {
    let custom: &JsCustomEvent = ev.unchecked_ref();
    serde_wasm_bindgen_json(&custom.detail())
}

fn serde_wasm_bindgen_json(v: &wasm_bindgen::JsValue) -> Option<Value> {
    if v.is_undefined() || v.is_null() {
        return None;
    }
    // Detail payloads are small plain objects; round-tripping through JSON
    // keeps the rest of the crate on serde_json values.
    js_sys::JSON::stringify(v)
        .ok()
        .and_then(|s| s.as_string())
        .and_then(|s| serde_json::from_str(&s).ok())
}
