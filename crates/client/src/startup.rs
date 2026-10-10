//! Entry point: hydrate the islands, then wire the plain-DOM behaviour.

use wasm_bindgen::prelude::wasm_bindgen;

use crate::dom::{self, query_all};
use crate::islands_bridge;

/// Runs on module evaluation (`import init from "client.js"; init(...)`).
#[wasm_bindgen(start)]
pub fn start() {
    // Without it a Rust panic reaches the console as a bare `unreachable`.
    console_error_panic_hook::set_once();
    ensure_hydration_bootstrap();
    hydrate_islands();

    crate::theme::install();
    crate::forms::install();
    crate::theme::install_sidebar();
    crate::forms::install_panel_bridges();
    crate::sheet::install();
    crate::map_glue::install_map();
    crate::map_glue::install_picker();
    crate::sw::install();
    crate::install::setup();
    // Readiness marker for the e2e smoke test: the bundle loaded, parsed and
    // ran to the end of startup (a stale or broken bundle never gets here).
    js_sys::Reflect::set(&dom::window(), &"__tkClientReady".into(), &true.into()).ok();
}

/// dioxus-web reads this global before hydrating; the Worker's bootstrap
/// script emits it, but a page rendered without it (tests, stale partials)
/// must not turn into a hard error.
fn ensure_hydration_bootstrap() {
    let win = dom::window();
    if js_sys::Reflect::get(
        &win,
        &wasm_bindgen::JsValue::from_str("initial_dioxus_hydration_data"),
    )
    .map(|v| v.is_string())
    .unwrap_or(false)
    {
        return;
    }
    let data = trinkhallen_ui::render::hydration_data();
    js_sys::Reflect::set(
        &win,
        &wasm_bindgen::JsValue::from_str("initial_dioxus_hydration_data"),
        &wasm_bindgen::JsValue::from_str(&data),
    )
    .ok();
}

/// One VirtualDom per `[data-island]` element, hydrated against the markup the
/// server pre-rendered. Unknown/missing islands are logged and left static —
/// the SSR markup still works without JS.
fn hydrate_islands() {
    hydrate_pending(&dom::document().document_element().expect("html element"));
}

/// Hydrate every island under `root` that has not been hydrated yet.
///
/// Markup swaps (the kiosk sheet's partial, the panel fragment, a rating or
/// report form replacing itself with the server's response) bring fresh island
/// markup into the page after startup, so hydration has to be re-runnable.
/// Hydrated roots are tagged `data-hydrated` to keep one VirtualDom per
/// element even when swaps land more than once.
pub fn hydrate_pending(root: &web_sys::Element) {
    for el in query_all(root, "[data-island]") {
        if dom::data_attr(&el, "hydrated").is_some() {
            continue;
        }
        let Some(name) = el.get_attribute("data-island").filter(|n| !n.is_empty()) else {
            continue;
        };
        let props = el
            .get_attribute("data-props")
            .unwrap_or_else(|| "null".to_owned());
        dom::set_data_attr(&el, "hydrated", "1");
        let Some(vdom) = islands_bridge::hydrate_island(&name, &props) else {
            dom::console_error(&format!("no island component registered as '{name}'"));
            continue;
        };
        // The browser bridge is the same instance for every island root.
        vdom.provide_root_context(islands_bridge::browser());
        dioxus_web::launch::launch_virtual_dom(
            vdom,
            dioxus_web::Config::new().hydrate(true).rootelement(el),
        );
    }
}
