//! Theme toggle: `<html data-theme>`, the sun/moon glyph, and the system-bar
//! colors (`theme-color` / `color-scheme`) that follow it.

use wasm_bindgen::JsValue;

use crate::dom::{self, query_doc, set_data_attr};

const SUN: &str = "☀";
const MOON: &str = "☾";

pub fn install() {
    let root = dom::document().document_element().expect("html element");
    let stored = dom::local_storage().and_then(|s| s.get_item("tk-theme").ok().flatten());
    if matches!(stored.as_deref(), Some("light") | Some("dark")) {
        let _ = root.set_attribute("data-theme", stored.as_deref().unwrap());
    }
    paint();

    for btn in query_doc("[data-theme-toggle]") {
        dom::on(&btn, "click", move |_| {
            let root = dom::document().document_element().expect("html element");
            let next = if root.get_attribute("data-theme").as_deref() == Some("light") {
                "dark"
            } else {
                "light"
            };
            let _ = root.set_attribute("data-theme", next);
            if let Some(s) = dom::local_storage() {
                let _ = s.set_item("tk-theme", next);
            }
            paint();
            // Map islands listen and reload their style to match.
            dom::dispatch("tk:theme-changed", &JsValue::from_str(next));
        });
    }
}

/// Glyph reflects the mode you'd switch TO (sun when currently dark).
fn paint() {
    let root = dom::document().document_element().expect("html element");
    let light = root.get_attribute("data-theme").as_deref() == Some("light");
    let glyph = if light { MOON } else { SUN };
    for el in query_doc("[data-theme-icon]") {
        el.set_text_content(Some(glyph));
    }

    // Keep the system UI in sync with the chosen theme. The value comes from
    // --color-bg so the CSS stays the single source of truth; the fallbacks
    // mirror app.css in case the var isn't resolved yet.
    let bg = dom::window()
        .get_computed_style_with_pseudo_elt(&root, "")
        .ok()
        .flatten()
        .and_then(|s| s.get_property_value("--color-bg").ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let color = bg.unwrap_or_else(|| if light { "#f5f2ec" } else { "#0a0a0a" }.to_owned());
    if let Some(meta) = query_doc("meta[name=theme-color]").first() {
        let _ = meta.set_attribute("content", &color);
    }
    if let Some(meta) = query_doc("meta[name=color-scheme]").first() {
        let _ = meta.set_attribute("content", if light { "light" } else { "dark" });
    }
}

/// Sidebar collapse/expand, persisted so a user who prefers map-only stays in
/// map-only mode. No-ops on routes without the controls.
pub fn install_sidebar() {
    use wasm_bindgen::JsCast;

    let Some(sidebar) = query_doc("[data-sidebar]").first().cloned() else {
        return;
    };
    let Some(expand) = query_doc("[data-sidebar-expand]").first().cloned() else {
        return;
    };

    let set_collapsed: std::rc::Rc<dyn Fn(bool)> = std::rc::Rc::new({
        let (sidebar, expand) = (sidebar.clone(), expand.clone());
        move |collapsed: bool| {
            set_data_attr(
                &sidebar,
                "collapsed",
                if collapsed { "true" } else { "false" },
            );
            set_data_attr(&expand, "show", if collapsed { "true" } else { "false" });
            if let Some(s) = dom::local_storage() {
                let _ = s.set_item("tk-sidebar-collapsed", if collapsed { "1" } else { "0" });
            }
        }
    });
    if dom::local_storage()
        .and_then(|s| s.get_item("tk-sidebar-collapsed").ok())
        .flatten()
        .as_deref()
        == Some("1")
    {
        set_collapsed(true);
    }
    for b in query_doc("[data-sidebar-collapse]") {
        let set_collapsed = set_collapsed.clone();
        dom::on(&b, "click", move |_| set_collapsed(true));
    }
    {
        let set_collapsed = set_collapsed.clone();
        dom::on(&expand, "click", move |_| set_collapsed(false));
    }

    // Mobile drag-to-collapse on the grab handle — the same gesture as the
    // kiosk sheet, via the shared helper.
    if let Some(handle) = dom::query_one(&sidebar, "[data-drag-handle]") {
        crate::drag::install(crate::drag::Opts {
            handle: handle.clone(),
            target: sidebar.clone(),
            measure: Some(sidebar.clone()),
            threshold: 0.25,
            on_dismiss: Box::new(move || set_collapsed(true)),
        });
        let _ = handle.dyn_into::<web_sys::Element>();
    }
}
