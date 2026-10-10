//! Lazy iOS Safari install prompt.
//!
//! iOS doesn't expose `beforeinstallprompt`, so the only path to a home-screen
//! install is the Share Sheet → "Add to Home Screen". The `@khmyznikov/pwa-install`
//! web component renders a localized tutorial card; for everyone else we never
//! load it. The component ships in its own esbuild bundle (`pwa.js`, built from
//! `web/pwa.js`) and is pulled in through a dynamic `import()` only here.

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen_futures::JsFuture;

use crate::dom;

const STORAGE_KEY: &str = "tk-install-prompt-dismissed-at";
const DISMISS_COOLDOWN_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Loads the install-prompt bundle on demand; same URL rules as the map bundle
/// (`window.tk_assets.pwa`, else the sibling `pwa.js`).
#[wasm_bindgen(inline_js = r#"
export function tk_load_pwa_install() {
    const url = globalThis.tk_assets?.pwa ?? new URL("../../pwa.js", import.meta.url).href;
    return import(url);
}
"#)]
unsafe extern "C" {
    fn tk_load_pwa_install() -> js_sys::Promise;
}

pub fn setup() {
    wasm_bindgen_futures::spawn_local(async {
        if !is_ios_safari() || is_standalone() || recently_dismissed() {
            return;
        }

        let module = match JsFuture::from(tk_load_pwa_install()).await {
            Ok(m) => m,
            Err(e) => {
                dom::console_error(&format!("pwa-install chunk failed to load: {e:?}"));
                return;
            }
        };
        let mount = match js_sys::Reflect::get(&module, &JsValue::from_str("mountPwaInstall")) {
            Ok(f) if f.is_function() => f,
            _ => {
                dom::console_error("pwa.js does not export mountPwaInstall");
                return;
            }
        };
        let lang = dom::doc_lang();
        let i18n = &trinkhallen_core::i18n::t;
        let attrs = serde_json::json!({
            "manifest-url": "/manifest.webmanifest",
            "name": "trinkhallen",
            "description": i18n(lang, "client.install.description"),
            "install-description": i18n(lang, "client.install.installDescription"),
            "disable-screenshots": "",
            "dismiss-key": STORAGE_KEY,
            // Dark-theme mapping. The library exposes these as CSS custom
            // properties; `styles` takes a JSON object and re-applies on render.
            "styles": {
                "--tint-color": "#5ee2ff",
                "--background-color": "#141414",
                "--background-color-primary": "#141414",
                "--background-color-button": "#5ee2ff",
                "--background-color-button-active": "#37c8e6",
                "--background-color-ripple": "rgba(94, 226, 255, 0.18)",
                "--base-color": "#1f1f1f",
                "--text-color-normal": "#f5f2ec",
                "--text-color-primary": "#f5f2ec",
                "--text-color-secondary": "#a8a39a",
                "--text-color-description": "#a8a39a",
                "--text-color-button": "#0a0a0a",
                "--touch-header-color": "#0a0a0a",
                "--divider-buttons-color": "#2a2a2a",
                "--border-bottom-color": "#2a2a2a",
                "--icon-how-to-color": "#5ee2ff",
                "--nav-btn-background-color": "#1f1f1f",
                "--nav-btn-fill-color": "#5ee2ff",
            },
        });
        let mount: &js_sys::Function = mount.unchecked_ref();
        let _ = js_sys::Reflect::apply(
            mount,
            &JsValue::NULL,
            &js_sys::Array::of1(&JsValue::from_str(&attrs.to_string())),
        );
    });
}

fn is_ios_safari() -> bool {
    let nav = dom::window().navigator();
    let ua = nav.user_agent().unwrap_or_default();
    let is_device = ua.contains("iPad")
        || ua.contains("iPhone")
        || ua.contains("iPod")
        || (nav.platform().unwrap_or_default() == "MacIntel" && nav.max_touch_points() > 1);
    let is_safari = ua.contains("Safari")
        && !(ua.contains("CriOS")
            || ua.contains("FxiOS")
            || ua.contains("EdgiOS")
            || ua.contains("OPiOS"));
    is_device && is_safari
}

fn is_standalone() -> bool {
    // Older iOS exposes `navigator.standalone`; modern browsers report the
    // PWA display mode via matchMedia.
    let standalone =
        js_sys::Reflect::get(&dom::window().navigator(), &JsValue::from_str("standalone"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    standalone || dom::match_media("(display-mode: standalone)")
}

fn recently_dismissed() -> bool {
    let Some(raw) = dom::local_storage()
        .and_then(|s| s.get_item(STORAGE_KEY).ok())
        .flatten()
    else {
        return false;
    };
    match raw.parse::<i64>() {
        Ok(t) => js_sys::Date::now() as i64 - t < DISMISS_COOLDOWN_MS,
        Err(_) => false,
    }
}
