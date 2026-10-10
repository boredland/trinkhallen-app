//! Non-island form behaviour: filter chips, panel refresh, back links, logout
//! and the report fieldset switch.
//!
//! Anything rendered inside a `[data-island]` root belongs to the island that
//! hydrates it (see `trinkhallen_ui::islands`); these listeners only cover the
//! static markup.

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Element, HtmlFormElement, HtmlInputElement, HtmlSelectElement, SubmitEvent};

use crate::dom::{self, query_all, query_doc, query_one};
use crate::net;
use crate::timers::Debounce;

/// Wire everything that lives outside island roots.
pub fn install() {
    for form in query_doc("[data-filter-form]") {
        if inside_island(&form) {
            continue;
        }
        attach_filter_form(&form);
    }
    for el in query_doc("[data-back]") {
        attach_back_link(&el);
    }
    for form in query_doc("[data-logout-form]") {
        attach_logout(&form);
    }
    for root in query_doc("[data-report-form]") {
        if inside_island(&root) {
            continue;
        }
        attach_report_form(&root);
    }
}

/// Island roots render into their own VirtualDom; static siblings do not.
fn inside_island(el: &Element) -> bool {
    let mut cur = Some(el.clone());
    while let Some(node) = cur {
        if node.has_attribute("data-island") {
            return true;
        }
        cur = node.parent_element();
    }
    false
}

// ── Filter chips ─────────────────────────────────────────────────────────────
//
// Chip `<label>`s wrap checkboxes named e.g. `pay_cards`, `tag_wc`, `open_now`.
// On change we translate that into the URL shape the server expects
// (`?pay=cards,contactless&tags=wc&open_now=1&q=…`), rewrite the URL via
// replaceState and fire `tk:filters-changed` so the map and the side panel
// refresh against the same filter.

fn build_filter_query(form: &HtmlFormElement) -> Vec<(String, String)> {
    let fields = net::form_fields(form);
    let mut pay: Vec<String> = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    let mut open_now = String::new();
    let mut needs_hours = String::new();
    let mut q = String::new();
    for (name, value) in fields {
        if let Some(key) = name.strip_prefix("pay_") {
            pay.push(key.to_owned());
        } else if let Some(key) = name.strip_prefix("tag_") {
            tags.push(key.to_owned());
        } else {
            match name.as_str() {
                "open_now" => open_now = value,
                "needs_hours" => needs_hours = value,
                "q" => q = value.trim().to_owned(),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    if !pay.is_empty() {
        out.push(("pay".to_owned(), pay.join(",")));
    }
    if !tags.is_empty() {
        out.push(("tags".to_owned(), tags.join(",")));
    }
    if !open_now.is_empty() {
        out.push(("open_now".to_owned(), "1".to_owned()));
    }
    if !needs_hours.is_empty() {
        out.push(("needs_hours".to_owned(), "1".to_owned()));
    }
    if !q.is_empty() {
        out.push(("q".to_owned(), q));
    }
    out
}

fn attach_filter_form(form: &Element) {
    let Some(form) = form.clone().dyn_into::<HtmlFormElement>().ok() else {
        return;
    };
    // Reflect URL into chip state on initial load (covers bfcache restore).
    let search = dom::location_search();
    let pay: Vec<String> = csv(dom::query_get(&search, "pay").as_deref());
    let tags: Vec<String> = csv(dom::query_get(&search, "tags").as_deref());
    let open_now = dom::query_get(&search, "open_now").as_deref() == Some("1");
    let needs_hours = dom::query_get(&search, "needs_hours").as_deref() == Some("1");
    for input in query_all(&form, "input[type=checkbox]") {
        let Some(input) = input.dyn_into::<HtmlInputElement>().ok() else {
            continue;
        };
        let name = input.name();
        if let Some(key) = name.strip_prefix("pay_") {
            input.set_checked(pay.iter().any(|p| p == key));
        } else if let Some(key) = name.strip_prefix("tag_") {
            input.set_checked(tags.iter().any(|t| t == key));
        } else if name == "open_now" {
            input.set_checked(open_now);
        } else if name == "needs_hours" {
            input.set_checked(needs_hours);
        }
    }

    let debounce = Debounce::new(150);
    {
        // "Offen jetzt" and "Zeiten fehlen" are mutually exclusive — one asks
        // for kiosks that resolve to an open status right now, the other asks
        // for kiosks with no hours data at all. Toggling one unticks the other.
        let scope = form.clone();
        dom::on(&form, "change", move |e| {
            let Some(t) = e
                .target()
                .and_then(|t| t.dyn_into::<HtmlInputElement>().ok())
            else {
                return;
            };
            if t.type_() != "checkbox" || !t.checked() {
                return;
            }
            let pairs = [("open_now", "needs_hours"), ("needs_hours", "open_now")];
            for (a, b) in pairs {
                if t.name() == a {
                    if let Some(other) = query_one(&scope, &format!("input[name=\"{b}\"]"))
                        .and_then(|e| e.dyn_into::<HtmlInputElement>().ok())
                    {
                        other.set_checked(false);
                    }
                }
            }
        });
    }

    let submit = {
        let form = form.clone();
        let debounce = debounce.clone();
        move || {
            let form = form.clone();
            let debounce = debounce.clone();
            debounce.schedule(move || {
                let next = build_filter_query(&form);
                if let Some(url) = dom::rewrite_query(&dom::location_href(), &[], &[]) {
                    let url = with_query(&url, &next);
                    dom::replace_state(&url);
                }
                dom::dispatch("tk:filters-changed", &JsValue::NULL);
            });
        }
    };

    {
        let submit = submit.clone();
        dom::on(&form, "change", move |_| submit());
    }
    // No island is present on this markup path (see `inside_island`), so the
    // panel refresh has to happen here: an island-driven change would do it
    // itself and would double-fetch if we also listened for `tk:filters-changed`.
    dom::on(&dom::window(), "tk:filters-changed", |_| {
        refresh_panel(&dom::location_search());
    });
    {
        let submit = submit.clone();
        dom::on(&form, "input", move |e| {
            let is_input = e
                .target()
                .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
                .map(|el| el.tag_name() == "INPUT")
                .unwrap_or(false);
            if is_input {
                submit();
            }
        });
    }
    dom::on(&form, "submit", move |e| {
        e.prevent_default();
        submit();
    });
}

fn csv(raw: Option<&str>) -> Vec<String> {
    raw.map(|s| {
        s.split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// `path + "?" + query`, keeping unrelated parameters off the URL rewrite.
fn with_query(url: &str, pairs: &[(String, String)]) -> String {
    let (path, search) = url.split_once('?').unwrap_or((url, ""));
    let mut kept: Vec<(String, String)> = Vec::new();
    dom::for_each_query(search, |k, v| {
        if !pairs.iter().any(|(pk, _)| pk == k) {
            kept.push((k.to_owned(), v.to_owned()));
        }
    });
    kept.extend(pairs.iter().cloned());
    let q = dom::query_string(&kept);
    if q.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{q}")
    }
}

// ── Side panel ───────────────────────────────────────────────────────────────

/// Swap the map page's side panel with the fragment the server renders for the
/// current filter (`src/routes/api.kiosks.tsx`).
pub fn refresh_panel(search: &str) {
    let Some(panel) = dom::document().get_element_by_id("kiosk-panel") else {
        return;
    };
    let Some(base) = dom::data_attr(&panel, "panel-url") else {
        return;
    };
    let origin = dom::location_origin();

    let Some(url) = web_sys::Url::new_with_base(&base, &origin).ok() else {
        return;
    };
    let params = url.search_params();
    let mut present: Vec<String> = Vec::new();
    dom::for_each_query(search, |k, v| {
        params.set(k, v);
        present.push(k.to_owned());
    });
    for k in ["pay", "tags", "open_now", "needs_hours", "q"] {
        if !present.iter().any(|p| p == k) {
            let _ = params.delete(k);
        }
    }
    let href = url.href();

    wasm_bindgen_futures::spawn_local(async move {
        match net::get_text(&href, "text/html").await {
            Ok(res) if (200..300).contains(&res.status) => {
                if let Some(el) = dom::document().get_element_by_id("kiosk-panel") {
                    dom::inner_html(&el, &res.body);
                    crate::startup::hydrate_pending(&el);
                }
            }
            Ok(_) => {}
            Err(e) => dom::console_error(&format!("panel refresh failed: {e}")),
        }
    });
}

/// Bridge bbox changes from the map into the panel's `data-panel-url`, so the
/// next filter change hits the right bbox.
pub fn install_panel_bridges() {
    dom::on(&dom::window(), "tk:bbox-changed", |e| {
        let Some(panel) = dom::document().get_element_by_id("kiosk-panel") else {
            return;
        };
        let Some(bbox) = crate::net::event_detail(&e).and_then(|d| {
            d.get("bboxString")
                .and_then(|b| b.as_str())
                .map(str::to_owned)
        }) else {
            return;
        };
        let base =
            dom::data_attr(&panel, "panel-url").unwrap_or_else(|| "/api/kiosks/panel".to_owned());
        if let Some(url) = dom::rewrite_query(&base, &[("bbox", Some(bbox.as_str()))], &[]) {
            dom::set_data_attr(&panel, "panel-url", &url);
        }
        refresh_panel(&dom::location_search());
    });
    // Geolocate on the map threads the user position into the sidebar fetch so
    // the list re-sorts by distance. The `origin` param sticks to
    // `data-panel-url` so subsequent bbox/filter changes keep the sort.
    dom::on(&dom::window(), "tk:origin-changed", |e| {
        let Some(panel) = dom::document().get_element_by_id("kiosk-panel") else {
            return;
        };
        let Some(detail) = crate::net::event_detail(&e) else {
            return;
        };
        let (Some(lat), Some(lng)) = (
            detail.get("lat").and_then(|v| v.as_f64()),
            detail.get("lng").and_then(|v| v.as_f64()),
        ) else {
            return;
        };
        let origin_param = format!("{lat:.5},{lng:.5}");
        let base =
            dom::data_attr(&panel, "panel-url").unwrap_or_else(|| "/api/kiosks/panel".to_owned());
        if let Some(url) =
            dom::rewrite_query(&base, &[("origin", Some(origin_param.as_str()))], &[])
        {
            dom::set_data_attr(&panel, "panel-url", &url);
        }
        refresh_panel(&dom::location_search());
    });
}

// ── Back links ───────────────────────────────────────────────────────────────

/// Prefer `history.back()` when we came from the same origin, so the back link
/// on `/k/:id` returns to the exact map viewport the user was looking at.
fn attach_back_link(el: &Element) {
    dom::on(el, "click", |e| {
        let referrer = dom::document().referrer();
        if referrer.starts_with(&dom::location_origin()) && dom::history_length() > 1 {
            e.prevent_default();
            dom::history_back();
        }
    });
}

// ── Logout ───────────────────────────────────────────────────────────────────

/// The service worker caches navigations, so a plain form redirect paints the
/// cached logged-in shell. Intercept the submit, POST it, drop the runtime
/// cache and only then navigate home. Plain forms still work without JS.
fn attach_logout(form: &Element) {
    if dom::data_attr(form, "logout-wired").as_deref() == Some("1") {
        return;
    }
    dom::set_data_attr(form, "logout-wired", "1");
    let Some(form) = form.clone().dyn_into::<HtmlFormElement>().ok() else {
        return;
    };
    let submit_form = form.clone();
    dom::on(&form, "submit", move |e: web_sys::Event| {
        let Ok(ev) = e.dyn_into::<SubmitEvent>() else {
            return;
        };
        ev.prevent_default();
        let form = submit_form.clone();
        wasm_bindgen_futures::spawn_local(async move {
            if let Some(btn) = query_one(&form, "button[type='submit']")
                .and_then(|b| b.dyn_into::<web_sys::HtmlButtonElement>().ok())
            {
                btn.set_disabled(true);
            }
            // Serialize the form so handlers that read fields (e.g. /me/delete
            // with its `confirm=yes` checkbox) actually see them.
            let fields = net::form_fields(&form);
            let action = form.action();
            let _ = net::post_form(&action, fields).await;
            purge_runtime_cache().await;
            let _ = dom::location().replace("/");
        });
    });
}

async fn purge_runtime_cache() {
    let Ok(storage) = dom::window().caches() else {
        return;
    };
    let Ok(keys) = JsFuture::from(storage.keys()).await else {
        return;
    };
    let keys: Vec<JsValue> = js_sys::Array::from(&keys).iter().collect();
    for key in keys {
        let Some(name) = key.as_string() else {
            continue;
        };
        if name.starts_with("tk-runtime-") {
            let _ = storage.delete(&name);
        }
    }
}

// ── Report form ──────────────────────────────────────────────────────────────

/// Show only the fieldset matching the selected `kind`.
fn attach_report_form(root: &Element) {
    let Some(select) =
        query_one(root, "select[name=kind]").and_then(|s| s.dyn_into::<HtmlSelectElement>().ok())
    else {
        return;
    };
    let fieldsets = query_all(root, "fieldset[data-kind]");
    {
        let scope = select.clone();
        let apply = std::rc::Rc::new(move || {
            let kind = scope.value();
            for fs in &fieldsets {
                let hidden = dom::data_attr(fs, "kind").as_deref() != Some(kind.as_str());
                let _ = fs.class_list().toggle_with_force("hidden", hidden);
            }
        });
        {
            let apply = apply.clone();
            dom::on(&select, "change", move |_| apply());
        }
        apply();
    }
}
