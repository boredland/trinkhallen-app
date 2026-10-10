//! Kiosk detail sheet — opens over the map without reloading.
//!
//! Slides up from the bottom on mobile, in from the right on desktop. The URL
//! moves via `pushState` (so refresh / share / browser-back keep working and
//! the full SSR `/k/:id` page stays the no-JS fallback).

use std::cell::RefCell;

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Element, Event, HtmlElement};

use crate::dom::{self, query_doc};
use trinkhallen_core::i18n::{DEFAULT_LANG, Lang, lang_from_path, path_for_lang};

const SHEET_ID: &str = "kiosk-sheet";
const BACKDROP_ID: &str = "kiosk-sheet-backdrop";
const BODY_ID: &str = "kiosk-sheet-body";

#[derive(Default)]
struct State {
    /// `/k/<id>` while open; `None` when closed.
    open_url: Option<String>,
    /// True when the user landed directly on `/k/:id` (the initial SSR opens
    /// the sheet for us, no pushState yet). On close we then rewrite to "/".
    pushed_history: bool,
    /// Bumped by every open or close so an in-flight fetch from a superseded
    /// open can't reopen the sheet when it resolves.
    open_seq: u32,
    /// The sidebar's `data-collapsed` before we hid it for the sheet.
    sidebar_prev_collapsed: Option<String>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// A kiosk deep link in the active locale (mirrors the URL the user is on).
fn kiosk_href(id: &str) -> String {
    path_for_lang(
        &format!("/k/{id}"),
        lang_from_path(&dom::location_pathname()),
    )
}

fn is_map_page() -> bool {
    let bare = dom::bare_pathname();
    bare == "/" || bare.is_empty() || bare.starts_with("/k/")
}

fn element(id: &str) -> Option<Element> {
    dom::document().get_element_by_id(id)
}

async fn fetch_partial(href: &str) -> Option<String> {
    let url = dom::rewrite_query(href, &[("partial", Some("1"))], &[])?;
    let res = crate::net::get_text(&url, "text/html").await.ok()?;
    (200..300).contains(&res.status).then_some(res.body)
}

fn set_open(open: bool) {
    let (Some(sheet), Some(backdrop)) = (element(SHEET_ID), element(BACKDROP_ID)) else {
        return;
    };
    dom::set_data_attr(&sheet, "open", if open { "true" } else { "false" });
    dom::set_data_attr(&backdrop, "open", if open { "true" } else { "false" });
    sheet
        .set_attribute("aria-hidden", if open { "false" } else { "true" })
        .ok();
    let _ = dom::body()
        .style()
        .set_property("overflow", if open { "hidden" } else { "" });
    if open {
        hide_sidebar_for_sheet();
    } else {
        restore_sidebar_from_sheet();
    }
}

fn hide_sidebar_for_sheet() {
    let Some(sidebar) = query_doc("[data-sidebar]").first().cloned() else {
        return;
    };
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if st.sidebar_prev_collapsed.is_none() {
            st.sidebar_prev_collapsed =
                Some(dom::data_attr(&sidebar, "collapsed").unwrap_or("false".into()));
        }
    });
    dom::set_data_attr(&sidebar, "collapsed", "true");
}

fn restore_sidebar_from_sheet() {
    let Some(sidebar) = query_doc("[data-sidebar]").first().cloned() else {
        return;
    };
    let prev = STATE.with(|s| s.borrow_mut().sidebar_prev_collapsed.take());
    if let Some(prev) = prev {
        dom::set_data_attr(&sidebar, "collapsed", &prev);
    }
}

/// Kiosk id a href points at, in any locale (`None` when it isn't a /k/ link).
fn id_from_href(href: &str) -> Option<String> {
    let url = web_sys::Url::new_with_base(href, &dom::location_origin()).ok()?;
    let bare = path_for_lang(&url.pathname(), DEFAULT_LANG);
    bare.strip_prefix("/k/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .map(str::to_owned)
}

fn dispatch_selection(id: Option<&str>) {
    let detail = js_sys::Object::new();
    js_sys::Reflect::set(
        &detail,
        &JsValue::from_str("id"),
        &match id {
            Some(id) => JsValue::from_str(id),
            None => JsValue::NULL,
        },
    )
    .ok();
    dom::dispatch("tk:selected-kiosk", &detail);
}

async fn open_sheet(href: String, push: bool) {
    let seq = STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.open_seq = st.open_seq.wrapping_add(1);
        st.open_seq
    });
    // Dispatch eagerly so the halo lights up before the fetch resolves.
    dispatch_selection(id_from_href(&href).as_deref());

    let html = fetch_partial(&href).await;
    // Backdrop-close (or another open) during the in-flight fetch: a newer
    // event bumped open_seq, so let it own the sheet state and exit.
    let fresh = STATE.with(|s| s.borrow().open_seq == seq);
    if !fresh {
        return;
    }
    let Some(html) = html else {
        // Fallback to full navigation if the partial fails.
        let _ = dom::location().set_href(&href);
        return;
    };
    let Some(body) = element(BODY_ID) else {
        let _ = dom::location().set_href(&href);
        return;
    };
    dom::inner_html(&body, &html);
    body.set_scroll_top(0);
    // The partial carries island markup (rating, check-in) for the kiosk page;
    // hydration has to run again for it to become interactive.
    crate::startup::hydrate_pending(&body);
    // Reattach the close handlers injected with the new body.
    attach_in_body();

    // "Was the sheet already open before this swap" decides push vs replace:
    // opening fresh from the map pushes `/k/<id>` so the back button returns to
    // the map, while swapping between kiosks replaces — otherwise closing has
    // to walk back through every previous sheet.
    let (was_open, pushed) = STATE.with(|s| {
        let st = s.borrow();
        (st.open_url.is_some(), st.pushed_history)
    });
    if push {
        let path = web_sys::Url::new_with_base(&href, &dom::location_origin())
            .map(|u| format!("{}{}", u.pathname(), u.search()))
            .unwrap_or_else(|_| href.clone());
        if was_open && pushed {
            dom::replace_state(&path);
        } else {
            dom::push_state(&path);
            STATE.with(|s| s.borrow_mut().pushed_history = true);
        }
    }
    STATE.with(|s| s.borrow_mut().open_url = Some(href));
    set_open(true);
}

fn close_sheet(via_pop: bool) {
    // Invalidate any in-flight openSheet.
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.open_seq = st.open_seq.wrapping_add(1);
    });
    let open = STATE.with(|s| s.borrow_mut().open_url.take());
    if open.is_none() {
        return;
    }
    set_open(false);
    dispatch_selection(None);
    if let Some(body) = element(BODY_ID) {
        // Delay clearing until after the transition so the user doesn't see a
        // blank flash. 220ms > the 200ms CSS duration.
        dom::set_timeout(
            move || {
                let still_closed = STATE.with(|s| s.borrow().open_url.is_none());
                if still_closed {
                    dom::inner_html(&body, "");
                }
            },
            220,
        );
    }
    if via_pop {
        return;
    }
    // history.back() works when we got here via pushState. If the user landed
    // directly on /k/:id, back would leave the origin entirely; rewrite to "/"
    // without navigating instead.
    let (pushed, bare) = STATE.with(|s| (s.borrow_mut().pushed_history, dom::bare_pathname()));
    if pushed {
        dom::history_back();
        STATE.with(|s| s.borrow_mut().pushed_history = false);
    } else if bare.starts_with("/k/") {
        dom::replace_state(&path_for_lang(
            "/",
            lang_from_path(&dom::location_pathname()),
        ));
    }
}

fn attach_in_body() {
    if element(BODY_ID).is_none() {
        return;
    }
    for a in query_doc(&format!(
        "#{BODY_ID} [data-back], #{BODY_ID} [data-sheet-close]"
    )) {
        if dom::data_attr(&a, "sheet-wired").as_deref() == Some("1") {
            continue;
        }
        dom::set_data_attr(&a, "sheet-wired", "1");
        dom::on(&a, "click", |e: Event| {
            e.prevent_default();
            close_sheet(false);
        });
    }
    // Other behaviour (check-in islands) re-binds after a sheet swap.
    dom::dispatch("tk:sheet-body-swapped", &JsValue::NULL);
}

/// Installation: idempotent DOM wiring for the map page's sheet container.
pub fn install() {
    if !is_map_page() {
        return;
    }
    let Some(sheet) = element(SHEET_ID) else {
        return;
    };

    // SSR may have pre-opened the sheet (deep link path). Adopt that state
    // without a pushState.
    if dom::data_attr(&sheet, "open").as_deref() == Some("true") {
        let initial = dom::data_attr(&sheet, "initial-href").unwrap_or_else(dom::location_pathname);
        STATE.with(|s| {
            let mut st = s.borrow_mut();
            st.open_url = Some(initial.clone());
            st.pushed_history = false;
        });
        attach_in_body();
        let _ = dom::body().style().set_property("overflow", "hidden");
        dispatch_selection(id_from_href(&initial).as_deref());
    }

    // Delegated click handler for every `a[href="/k/..."]`; also focuses the
    // map when the anchor carries data-lng / data-lat (list items do).
    dom::on(&dom::document(), "click", |ev: Event| {
        let Some(target) = ev.target().and_then(|t| t.dyn_into::<Element>().ok()) else {
            return;
        };
        let Some(anchor) = target.closest("a[href]").ok().flatten() else {
            return;
        };
        if anchor.get_attribute("target").as_deref() == Some("_blank") {
            return;
        }
        let Some(href) = anchor.get_attribute("href") else {
            return;
        };
        if id_from_href(&href).is_none() {
            return;
        }
        if dom::read_number(&ev, "button").unwrap_or(0.0) != 0.0 {
            return;
        }
        for key in ["metaKey", "ctrlKey", "shiftKey"] {
            if dom::read_property(&ev, key).as_bool() == Some(true) {
                return;
            }
        }
        ev.prevent_default();
        let lng = dom::data_attr(&anchor, "lng").and_then(|v| v.parse().ok());
        let lat = dom::data_attr(&anchor, "lat").and_then(|v| v.parse().ok());
        if let (Some(lng), Some(lat)) = (lng, lat) {
            let detail = js_sys::Object::new();
            js_sys::Reflect::set(&detail, &JsValue::from_str("lng"), &JsValue::from_f64(lng)).ok();
            js_sys::Reflect::set(&detail, &JsValue::from_str("lat"), &JsValue::from_f64(lat)).ok();
            dom::dispatch("tk:focus-kiosk", &detail);
        }
        wasm_bindgen_futures::spawn_local(open_sheet(href, true));
    });

    // Map markers dispatch this when a single (non-cluster) point is clicked.
    dom::on(&dom::window(), "tk:open-kiosk", |ev| {
        let Some(detail) = crate::net::event_detail(&ev) else {
            return;
        };
        let Some(id) = detail.get("id").and_then(|v| v.as_str()) else {
            return;
        };
        wasm_bindgen_futures::spawn_local(open_sheet(kiosk_href(id), true));
    });

    // Backdrop click + close button + ESC on desktop.
    if let Some(backdrop) = element(BACKDROP_ID) {
        dom::on(&backdrop, "click", |_| close_sheet(false));
    }
    dom::on(&dom::document(), "click", |ev| {
        let Some(target) = ev.target().and_then(|t| t.dyn_into::<Element>().ok()) else {
            return;
        };
        let Some(closer) = target.closest("[data-sheet-close]").ok().flatten() else {
            return;
        };
        let in_sheet = element(SHEET_ID)
            .map(|s| s.contains(Some(&closer)))
            .unwrap_or(false);
        if in_sheet {
            ev.prevent_default();
            close_sheet(false);
        }
    });
    dom::on(&dom::document(), "keydown", |ev| {
        let key = dom::read_string(&ev, "key");
        let open = STATE.with(|s| s.borrow().open_url.is_some());
        if key.as_deref() == Some("Escape") && open {
            close_sheet(false);
        }
    });

    // browser-back + forward.
    dom::on(&dom::window(), "popstate", |_| {
        let open = STATE.with(|s| s.borrow().open_url.is_some());
        if is_map_page() && open {
            close_sheet(true);
        } else if dom::bare_pathname().starts_with("/k/") && !open {
            wasm_bindgen_futures::spawn_local(open_sheet(
                format!("{}{}", dom::location_pathname(), dom::location_search()),
                false,
            ));
        }
    });

    install_sheet_drag();
}

fn install_sheet_drag() {
    let Some(sheet) = element(SHEET_ID) else {
        return;
    };
    let Some(handle) = dom::query_one(&sheet, "[data-drag-handle]") else {
        return;
    };
    // The inner panel is the only direct child (the backdrop is a sibling of
    // #kiosk-sheet); its height sets the dismiss distance.
    let panel = dom::query_all(&sheet, ":scope > div").first().cloned();
    crate::drag::install(crate::drag::Opts {
        handle,
        target: sheet,
        measure: panel,
        threshold: 0.3,
        on_dismiss: Box::new(|| close_sheet(false)),
    });
}

/// Kept for the harness: whether a sheet is currently open.
#[allow(dead_code)]
pub fn is_open() -> bool {
    STATE.with(|s| s.borrow().open_url.is_some())
}

#[allow(dead_code)]
fn _unused(_: Lang, _: HtmlElement, _: JsFuture) {}
