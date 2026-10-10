//! The map half of the client: mounts `web/map.js` and feeds it the features
//! Rust loads and filters.
//!
//! The module is fetched lazily (dynamic `import()` of `./map.js`) only when a
//! page actually has a `#map` or `#pick-map` container, keeping map-free pages
//! free of MapLibre.

use std::cell::{Cell, RefCell};

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen_futures::JsFuture;

use crate::dom;
use crate::map_data::{self, DETAIL_ZOOM};

/// Loads the MapLibre bundle on demand. The URL is `window.tk_assets.map` when
/// the page provides one (the hook for content-hashed asset names), otherwise
/// the sibling `map.js` of the glue's `snippets/<crate>/` directory.
#[wasm_bindgen(inline_js = r#"
export function tk_load_map_module() {
    const url = globalThis.tk_assets?.map ?? new URL("../../map.js", import.meta.url).href;
    return import(url);
}
"#)]
unsafe extern "C" {
    fn tk_load_map_module() -> js_sys::Promise;
}

#[derive(Clone)]
struct MapModule(JsValue);

async fn map_module() -> Result<MapModule, String> {
    if let Some(m) = MODULE.with(|m| m.borrow().clone()) {
        return Ok(m);
    }
    let ns = JsFuture::from(tk_load_map_module())
        .await
        .map_err(|e| format!("map.js failed to load: {e:?}"))?;
    let m = MapModule(ns);
    MODULE.with(|slot| *slot.borrow_mut() = Some(m.clone()));
    Ok(m)
}

thread_local! {
    static MODULE: RefCell<Option<MapModule>> = const { RefCell::new(None) };
    static MAP: RefCell<Option<MapHandle>> = const { RefCell::new(None) };
}

#[derive(Clone)]
struct MapHandle {
    handle: JsValue,
    /// Last viewport reported by map.js (`{ bbox, zoom }`).
    bbox: [f64; 4],
    zoom: f64,
    /// Bumped on every refresh so a slow response from a superseded viewport
    /// can't overwrite fresher data.
    seq: u32,
}

/// Mount `#map` if the page has one and wire the data flow: viewport →
/// `/data/*` → filter → map source.
pub fn install_map() {
    let Some(el) = dom::document().get_element_by_id("map") else {
        return;
    };

    wasm_bindgen_futures::spawn_local(async move {
        let module = match map_module().await {
            Ok(m) => m,
            Err(e) => return dom::console_error(&e),
        };
        let mount = match fn_of(&module.0, "mountMap") {
            Some(f) => f,
            None => return dom::console_error("map.js does not export mountMap"),
        };
        let opts = js_sys::Object::new();
        js_sys::Reflect::set(&opts, &JsValue::from_str("geolocate"), &JsValue::TRUE).ok();
        let handle = match js_sys::Reflect::apply(
            &mount,
            &JsValue::NULL,
            &js_sys::Array::of3(&el.into(), &opts, &js_sys::Object::new()),
        ) {
            Ok(h) => h,
            Err(e) => return dom::console_error(&format!("mountMap failed: {e:?}")),
        };

        MAP.with(|m| {
            *m.borrow_mut() = Some(MapHandle {
                handle,
                bbox: [0.0, 0.0, 0.0, 0.0],
                zoom: 12.0,
                seq: 0,
            })
        });
        install_map_listeners();
        refresh();
    });
}

fn install_map_listeners() {
    // map.js reports the initial viewport once the style loads.
    dom::on(&dom::window(), "tk:map-ready", |e| {
        update_viewport(&e);
        refresh();
    });
    dom::on(&dom::window(), "tk:bbox-changed", |e| {
        update_viewport(&e);
        refresh();
    });
    // Every `setStyle` (theme toggle) strips the kiosk sources; map.js re-adds
    // them empty, so repopulate.
    dom::on(&dom::window(), "tk:map-style-loaded", |e| {
        update_viewport(&e);
        refresh();
    });
    // The filter island rewrites the URL and dispatches; the map re-reads the
    // query so it shows exactly what the panel lists.
    dom::on(&dom::window(), "tk:filters-changed", |_| refresh());
    // Geolocate: the map already flew to user + nearest, but the nearest
    // lookup lives in map.js — call it explicitly per the module contract.
    dom::on(&dom::window(), "tk:origin-changed", |e| {
        let Some(detail) = crate::net::event_detail(&e) else {
            return;
        };
        let (Some(lat), Some(lng)) = (
            detail.get("lat").and_then(|v| v.as_f64()),
            detail.get("lng").and_then(|v| v.as_f64()),
        ) else {
            return;
        };
        call_map_method(
            "fitToUserAndNearest",
            &js_sys::Array::of2(&JsValue::from_f64(lat), &JsValue::from_f64(lng)),
        );
    });
}

fn update_viewport(e: &web_sys::Event) {
    let Some(detail) = crate::net::event_detail(e) else {
        return;
    };
    let bbox = detail
        .get("bbox")
        .and_then(|b| serde_json::from_value::<[f64; 4]>(b.clone()).ok());
    let zoom = detail.get("zoom").and_then(|z| z.as_f64());
    MAP.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(h) = m.as_mut() {
            if let Some(bbox) = bbox {
                h.bbox = bbox;
            }
            if let Some(zoom) = zoom {
                h.zoom = zoom;
            }
        }
    });
}

fn call_map_method(name: &str, args: &js_sys::Array) {
    let Some(call) = MAP.with(|m| m.borrow().clone()) else {
        return;
    };
    let Some(func) = fn_of(&call.handle, name) else {
        return;
    };
    let _ = js_sys::Reflect::apply(&func, &call.handle, args);
}

/// `obj[name]` as a callable.
fn fn_of(obj: &JsValue, name: &str) -> Option<js_sys::Function> {
    let f = js_sys::Reflect::get(obj, &JsValue::from_str(name)).ok()?;
    f.is_function().then(|| f.unchecked_into())
}

/// Load what the current viewport + filter imply and push it into the map.
/// Every call supersedes the previous one (see `MapHandle::seq`).
fn refresh() {
    let Some((handle, bbox, zoom)) = MAP.with(|m| {
        let mut m = m.borrow_mut();
        let h = m.as_mut()?;
        h.seq = h.seq.wrapping_add(1);
        Some((h.handle.clone(), h.bbox, h.zoom))
    }) else {
        return;
    };
    let seq = MAP.with(|m| m.borrow().as_ref().map(|h| h.seq).unwrap_or_default());
    let search = dom::location_search();
    let filter = map_data::filter_from_search(&search);
    let now = js_sys::Date::now() as i64;

    wasm_bindgen_futures::spawn_local(async move {
        // Summary band for the active zoom; the other bands stay empty until
        // the user zooms into them.
        if let Some(z) = map_data::active_summary_zoom(zoom) {
            let summary = map_data::summary_for_zoom(z).await;
            if is_current(seq) {
                let args =
                    js_sys::Array::of3(&handle, &JsValue::from_f64(z as f64), &to_js(&summary));
                if let Some(func) = module_fn("setSummary") {
                    let _ = js_sys::Reflect::apply(&func, &JsValue::NULL, &args);
                }
            }
        }

        // Detail source: empty below the threshold so a later zoom-in doesn't
        // briefly flash stale markers from the previous viewport.
        let detail = if zoom >= DETAIL_ZOOM {
            map_data::detail_features_for_view(bbox, &filter, now).await
        } else {
            map_data::empty_collection()
        };
        if is_current(seq) {
            let args = js_sys::Array::of2(&handle, &to_js(&detail));
            if let Some(func) = module_fn("setDetailFeatures") {
                let _ = js_sys::Reflect::apply(&func, &JsValue::NULL, &args);
            }
        }
    });
}

/// GeoJSON as a real JS object: MapLibre's `setData` treats a string as a URL.
fn to_js(v: &serde_json::Value) -> JsValue {
    js_sys::JSON::parse(&v.to_string()).unwrap_or(JsValue::NULL)
}

fn is_current(seq: u32) -> bool {
    MAP.with(|m| m.borrow().as_ref().map(|h| h.seq) == Some(seq))
}

fn module_fn(name: &str) -> Option<js_sys::Function> {
    let module = MODULE.with(|m| m.borrow().clone())?;
    fn_of(&module.0, name)
}

/// Mount `#pick-map` on /add: click drops a pin into the lat/lng inputs and
/// reverse-geocodes the address fields.
pub fn install_picker() {
    let Some(el) = dom::document().get_element_by_id("pick-map") else {
        return;
    };
    wasm_bindgen_futures::spawn_local(async move {
        let module = match map_module().await {
            Ok(m) => m,
            Err(e) => return dom::console_error(&e),
        };
        let mount = match fn_of(&module.0, "mountPicker") {
            Some(f) => f,
            None => return dom::console_error("map.js does not export mountPicker"),
        };
        let _ = js_sys::Reflect::apply(
            &mount,
            &JsValue::NULL,
            &js_sys::Array::of3(&el.into(), &js_sys::Object::new(), &js_sys::Object::new()),
        );
    });
}

/// Test/harness hook: has a map handle been mounted?
#[allow(dead_code)]
pub fn mounted() -> bool {
    MAP.with(|m| m.borrow().is_some())
}

#[allow(dead_code)]
fn _cell(_: Cell<bool>) {}
