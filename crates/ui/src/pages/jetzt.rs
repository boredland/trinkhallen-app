//! `/jetzt`: the PWA shortcut flow — locate, find the
//! nearest open kiosk, hand over to the native maps app. The behaviour lives
//! in a nonce'd inline script.

use dioxus::prelude::*;
use trinkhallen_core::i18n::{Lang, path_for_lang, t};

use crate::model::Nav;
use crate::pages::PageMeta;
use crate::render::{ClientEntry, to_html};

pub fn render(lang: Lang, nonce: &str) -> (String, PageMeta) {
    let home = path_for_lang("/", lang);
    let article = to_html(rsx! {
        article { class: "border-2 border-border bg-surface p-6",
            h1 { class: "font-display text-3xl tracking-wide text-fg sm:text-4xl", "{t(lang, \"page.jetzt.title\")}" }
            p {
                id: "jetzt-status",
                class: "mt-4 text-fg-muted",
                aria_live: "polite",
                "{t(lang, \"jetzt.intro\")}"
            }
            div { id: "jetzt-actions", class: "mt-6 hidden flex-col gap-3 sm:flex-row sm:flex-wrap",
                a { href: "{home}", class: "btn-neon", "{t(lang, \"jetzt.toMap\")}" }
                button { r#type: "button", id: "jetzt-retry", class: "btn-neon", "{t(lang, \"jetzt.retry\")}" }
            }
        }
    });

    // Key order is part of the inline script's message literal; values are JSON strings.
    let js = |key: &str| serde_json::Value::String(t(lang, key)).to_string();
    let m = format!(
        r#"{{"noGeo":{noGeo},"locating":{locating},"searching":{searching},"noneOpen":{noneOpen},"openingSuffix":{openingSuffix},"lookupFailed":{lookupFailed},"geoFailed":{geoFailed}}}"#,
        noGeo = js("jetzt.noGeo"),
        locating = js("jetzt.locating"),
        searching = js("jetzt.searching"),
        noneOpen = js("jetzt.noneOpen"),
        openingSuffix = js("jetzt.openingSuffix"),
        lookupFailed = js("jetzt.lookupFailed"),
        geoFailed = js("jetzt.geoFailed"),
    );
    let script = format!(
        r#"<script nonce="{nonce}">
              (() => {{
                const status = document.getElementById("jetzt-status");
                const actions = document.getElementById("jetzt-actions");
                const retry = document.getElementById("jetzt-retry");
                const setMsg = (m) => {{ if (status) status.textContent = m; }};
                const showFallback = () => {{
                  if (actions) {{
                    actions.classList.remove("hidden");
                    actions.classList.add("flex");
                  }}
                }};
                const M = {m};
                const go = () => {{
                  if (!("geolocation" in navigator)) {{
                    setMsg(M.noGeo);
                    showFallback();
                    return;
                  }}
                  setMsg(M.locating);
                  navigator.geolocation.getCurrentPosition(async (pos) => {{
                    const {{ latitude: lat, longitude: lng }} = pos.coords;
                    setMsg(M.searching);
                    try {{
                      const res = await fetch(`/api/kiosks/nearest-open?origin=${{lat}},${{lng}}`);
                      if (res.status === 404) {{
                        setMsg(M.noneOpen);
                        showFallback();
                        return;
                      }}
                      if (!res.ok) throw new Error("nearest lookup failed");
                      const data = await res.json();
                      setMsg(data.name + M.openingSuffix);
                      window.location.href = data.nav_url;
                    }} catch {{
                      setMsg(M.lookupFailed);
                      showFallback();
                    }}
                  }}, () => {{
                    setMsg(M.geoFailed);
                    showFallback();
                  }}, {{ enableHighAccuracy: true, timeout: 8000 }});
                }};
                retry?.addEventListener("click", go);
                go();
              }})();
            </script>"#,
        m = m,
    );

    let meta = PageMeta {
        title: Some(t(lang, "page.jetzt.title")),
        description: Some(t(lang, "page.jetzt.description")),
        noindex: true,
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Map),
        ..Default::default()
    };
    (format!("{article}{script}"), meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_is_a_nonce_inline_bootstrap() {
        let (body, meta) = render(Lang::De, "n0nce");
        assert!(body.contains("<script nonce=\"n0nce\">"), "{body}");
        assert!(body.contains("const M = {\"noGeo\":"), "{body}");
        assert!(
            body.contains(
                "const res = await fetch(`/api/kiosks/nearest-open?origin=${lat},${lng}`);"
            ),
            "{body}"
        );
        assert!(
            body.contains("window.location.href = data.nav_url;"),
            "{body}"
        );
        assert!(
            body.contains("{ enableHighAccuracy: true, timeout: 8000 }"),
            "{body}"
        );
        assert!(body.contains("id=\"jetzt-status\""), "{body}");
        assert!(body.contains("id=\"jetzt-actions\""), "{body}");
        assert!(body.contains("id=\"jetzt-retry\""), "{body}");
        assert!(meta.noindex);
        assert_eq!(meta.title.as_deref(), Some("Jetzt navigieren"));
    }
}
