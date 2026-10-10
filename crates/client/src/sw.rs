//! Service-worker registration + update prompt.
//!
//! `public/sw.js` no longer auto-`skipWaiting`s, so a new deploy installs into
//! the "waiting" state instead of swapping bundles under the running page.
//! This module notices the waiting worker and shows a reload toast; on accept
//! it hands control over (`SKIP_WAITING`) and reloads once the new worker has
//! taken control. Long-lived tabs re-check for updates whenever the tab
//! regains focus.

use std::cell::Cell;

use js_sys::Reflect;
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use wasm_bindgen_futures::JsFuture;
use web_sys::{ServiceWorkerRegistration, ServiceWorkerState};

use crate::dom::{self, query_doc};

const TOAST_ID: &str = "tk-sw-update-toast";

pub fn install() {
    if !dom::read_property(&dom::window().navigator(), "serviceWorker").is_object() {
        return;
    }
    if dom::location().protocol().ok().as_deref() != Some("https:") {
        return;
    }

    // Register after `load` so it never competes with first paint.
    dom::on(&dom::window(), "load", |_| {
        wasm_bindgen_futures::spawn_local(async {
            match registration().await {
                Ok(reg) => wire_update_flow(reg),
                Err(msg) => dom::console_error(&format!("SW registration failed: {msg}")),
            }
        });
    });

    // A controllerchange means a new SW has taken control — reload once so the
    // page runs against the new bundle. Guard against the reload loop that
    // fires on the very first SW activation (no prior controller).
    let reloading = Cell::new(false);
    let container = dom::window().navigator().service_worker();
    dom::on(&container, "controllerchange", move |_| {
        if reloading.get() {
            return;
        }
        reloading.set(true);
        let _ = dom::location().reload();
    });
}

/// `navigator.serviceWorker.register("/sw.js", { scope: "/" })`.
async fn registration() -> Result<ServiceWorkerRegistration, String> {
    let container = dom::window().navigator().service_worker();
    let promise = container.register("/sw.js");
    let reg = JsFuture::from(promise)
        .await
        .map_err(|e| format!("{e:?}"))?;
    reg.dyn_into::<ServiceWorkerRegistration>()
        .map_err(|_| "not a registration".to_owned())
}

fn wire_update_flow(reg: ServiceWorkerRegistration) {
    // An update may already be parked before this code runs.
    if reg.waiting().is_some() && has_controller() {
        show_update_toast(reg.clone());
    }

    {
        let events_target = reg.clone();
        let reg_for_state = reg.clone();
        dom::on(&events_target, "updatefound", move |_| {
            let Some(installing) = reg_for_state.installing() else {
                return;
            };
            let state_target = installing.clone();
            let reg_for_toast = reg_for_state.clone();
            dom::on(&state_target, "statechange", move |_| {
                // "installed" + an existing controller = an update, not the
                // first install.
                if installing.state() == ServiceWorkerState::Installed && has_controller() {
                    show_update_toast(reg_for_toast.clone());
                }
            });
        });
    }

    // Long-lived tabs: re-check for a new SW when the tab regains focus.
    dom::on(&dom::document(), "visibilitychange", move |_| {
        if dom::document().visibility_state() != web_sys::VisibilityState::Visible {
            return;
        }
        wasm_bindgen_futures::spawn_local(async {
            if let Ok(reg) = registration().await {
                let _ = reg.update();
            }
        });
    });
}

fn has_controller() -> bool {
    dom::window()
        .navigator()
        .service_worker()
        .controller()
        .is_some()
}

fn show_update_toast(reg: ServiceWorkerRegistration) {
    let lang = dom::doc_lang();
    // Guard on DOM presence rather than a latch, so a toast the user dismissed
    // can reappear if a further update lands later in the same session.
    if !query_doc(&format!("#{TOAST_ID}")).is_empty() {
        return;
    }

    let doc = dom::document();
    let toast = doc.create_element("div").expect("div");
    toast.set_id(TOAST_ID);
    let _ = toast.set_attribute("role", "status");
    let _ = toast.set_attribute(
        "class",
        "fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-3 border-2 border-neon-pink \
         bg-surface p-3 text-sm text-fg shadow-[var(--shadow-glow-pink)] sm:left-auto sm:right-3",
    );

    let label = doc.create_element("span").expect("span");
    let _ = label.set_attribute("class", "flex-1");
    label.set_text_content(Some(&trinkhallen_core::i18n::t(
        lang,
        "client.sw.newVersion",
    )));

    let reload = button(
        "shrink-0 cursor-pointer border-2 border-neon-pink bg-neon-pink px-3 py-1 font-bold uppercase \
         tracking-wider text-bg hover:opacity-90",
        &trinkhallen_core::i18n::t(lang, "client.sw.reload"),
    );
    let reload_el: web_sys::HtmlButtonElement = reload.clone().unchecked_into();
    {
        let button = reload_el.clone();
        let on_click = Closure::<dyn FnMut()>::new(move || {
            button.set_disabled(true);
            button.set_text_content(Some(&trinkhallen_core::i18n::t(
                dom::doc_lang(),
                "client.sw.loading",
            )));
            match reg.waiting().or_else(|| reg.active()) {
                Some(worker) => {
                    let msg = js_sys::Object::new();
                    Reflect::set(
                        &msg,
                        &JsValue::from_str("type"),
                        &JsValue::from_str("SKIP_WAITING"),
                    )
                    .ok();
                    let _ = worker.post_message(&msg);
                }
                // Edge case: the worker already controls the page — just reload.
                None => {
                    let _ = dom::location().reload();
                }
            }
        });
        reload_el.set_onclick(Some(on_click.as_ref().unchecked_ref()));
        on_click.forget();
    }

    let dismiss = button(
        "shrink-0 cursor-pointer px-2 py-1 text-fg-dim hover:text-fg",
        "✕",
    );
    let dismiss_el: web_sys::HtmlButtonElement = dismiss.clone().unchecked_into();
    let _ = dismiss_el.set_attribute(
        "aria-label",
        &trinkhallen_core::i18n::t(lang, "client.sw.close"),
    );
    {
        let toast = toast.clone();
        let on_click = Closure::<dyn FnMut()>::new(move || toast.remove());
        dismiss_el.set_onclick(Some(on_click.as_ref().unchecked_ref()));
        on_click.forget();
    }

    toast.append_child(&label).ok();
    toast.append_child(&reload).ok();
    toast.append_child(&dismiss).ok();
    dom::body().append_child(&toast).ok();
}

fn button(class: &str, text: &str) -> web_sys::Element {
    let b = dom::document().create_element("button").expect("button");
    let _ = b.set_attribute("type", "button");
    let _ = b.set_attribute("class", class);
    b.set_text_content(Some(text));
    b
}
