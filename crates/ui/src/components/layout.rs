//! Document shell: `<head>`, header chrome, footer.
//!
//! The head is assembled as a string rather than RSX: it needs a doctype,
//! raw JSON-LD / speculation-rules script bodies and `<link>`/`<meta>` tags
//! whose exact attribute set matters to crawlers and the CSP, none of which
//! benefit from a virtual DOM. The header and footer are RSX components.

use dioxus::prelude::*;
use trinkhallen_core::i18n::{DEFAULT_LANG, Lang, SUPPORTED_LANGS, path_for_lang, t};
use trinkhallen_core::ORIGIN;

use crate::model::{Nav, SessionUser};
use crate::render::{ClientEntry, Page, hydration_data, to_html};

const SITE: &str = "TRINKHALLEN.APP";

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// JSON for a `<script>` body: `<` escaped so `</script>` can't terminate it.
pub fn script_json(v: &serde_json::Value) -> String {
    serde_json::to_string(v).unwrap_or_default().replace('<', "\\u003c")
}

pub fn render_document(page: &Page, body: String) -> String {
    let lang = page.lang;
    let desc = page.description.clone().unwrap_or_else(|| t(lang, "meta.descriptionDefault"));
    let full_title = match &page.title {
        Some(t) => format!("{t} · {SITE}"),
        None => SITE.to_owned(),
    };
    // The locale-neutral path drives the canonical (re-prefixed for the
    // active locale) and the hreflang alternates; a page-supplied canonical
    // points at the clean target, so strip its origin and feed it through.
    let bare_source = match &page.canonical_url {
        Some(c) => c.strip_prefix(ORIGIN).unwrap_or(c).to_owned(),
        None => page.path.clone(),
    };
    let bare_path = path_for_lang(&bare_source, DEFAULT_LANG);
    let url_for = |l: Lang| format!("{ORIGIN}{}", path_for_lang(&bare_path, l));
    let canonical = url_for(lang);
    let og_image = format!("{ORIGIN}/og-1200x630.png");
    let is_map_page = page.entries.iter().any(|e| matches!(e, ClientEntry::Map | ClientEntry::Pick));
    let nonce = html_escape(&page.nonce);
    let e = html_escape;

    let mut h = String::with_capacity(8 * 1024 + body.len());
    h.push_str("<!DOCTYPE html>");
    h.push_str(&format!("<html lang=\"{}\" data-theme=\"dark\"><head>", lang.code()));
    h.push_str("<meta charset=\"utf-8\"/>");
    h.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"/>");
    // Dark default for the system bar; the client corrects it for light theme.
    h.push_str("<meta name=\"theme-color\" content=\"#0A0A0A\"/>");
    // Declared before any CSS so the navigation gap paints dark, not white.
    h.push_str("<meta name=\"color-scheme\" content=\"dark\"/>");
    h.push_str(&format!("<meta name=\"description\" content=\"{}\"/>", e(&desc)));
    if page.noindex {
        h.push_str("<meta name=\"robots\" content=\"noindex, nofollow\"/>");
    }
    h.push_str(&format!("<link rel=\"canonical\" href=\"{}\"/>", e(&canonical)));
    h.push_str(&format!("<meta property=\"og:title\" content=\"{}\"/>", e(&full_title)));
    h.push_str(&format!("<meta property=\"og:description\" content=\"{}\"/>", e(&desc)));
    h.push_str("<meta property=\"og:type\" content=\"website\"/>");
    h.push_str(&format!("<meta property=\"og:url\" content=\"{}\"/>", e(&canonical)));
    h.push_str(&format!("<meta property=\"og:image\" content=\"{og_image}\"/>"));
    h.push_str("<meta property=\"og:image:type\" content=\"image/png\"/>");
    h.push_str("<meta property=\"og:image:width\" content=\"1200\"/>");
    h.push_str("<meta property=\"og:image:height\" content=\"630\"/>");
    h.push_str(&format!("<meta property=\"og:image:alt\" content=\"{}\"/>", e(&t(lang, "meta.ogImageAlt"))));
    h.push_str(&format!("<meta property=\"og:locale\" content=\"{}\"/>", lang.og_locale()));
    h.push_str("<meta name=\"twitter:card\" content=\"summary_large_image\"/>");
    h.push_str(&format!("<meta name=\"twitter:title\" content=\"{}\"/>", e(&full_title)));
    h.push_str(&format!("<meta name=\"twitter:description\" content=\"{}\"/>", e(&desc)));
    h.push_str(&format!("<meta name=\"twitter:image\" content=\"{og_image}\"/>"));
    for l in SUPPORTED_LANGS {
        h.push_str(&format!("<link rel=\"alternate\" hreflang=\"{}\" href=\"{}\"/>", l.code(), e(&url_for(l))));
    }
    h.push_str(&format!("<link rel=\"alternate\" hreflang=\"x-default\" href=\"{}\"/>", e(&url_for(DEFAULT_LANG))));
    h.push_str(&format!("<title>{}</title>", e(&full_title)));
    h.push_str("<link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\"/>");
    h.push_str("<link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.svg\"/>");
    h.push_str("<link rel=\"manifest\" href=\"/manifest.webmanifest\"/>");
    // iOS only honours these for standalone "Add to Home Screen".
    h.push_str("<meta name=\"apple-mobile-web-app-capable\" content=\"yes\"/>");
    h.push_str("<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\"/>");
    h.push_str("<meta name=\"apple-mobile-web-app-title\" content=\"trinkhallen\"/>");
    if is_map_page {
        h.push_str("<link rel=\"preconnect\" href=\"https://tiles.openfreemap.org\" crossorigin=\"\"/>");
        // The style JSON is MapLibre's first request; preload it ahead of our JS.
        h.push_str(
            "<link rel=\"preload\" href=\"https://tiles.openfreemap.org/styles/dark\" as=\"fetch\" crossorigin=\"\"/>",
        );
    }
    for css in &page.assets.css {
        h.push_str(&format!("<link rel=\"stylesheet\" href=\"{}\"/>", e(css)));
    }
    if is_map_page && !page.assets.map_js.is_empty() {
        h.push_str(&format!("<link rel=\"modulepreload\" href=\"{}\"/>", e(&page.assets.map_js)));
    }
    for block in &page.json_ld {
        h.push_str(&format!("<script type=\"application/ld+json\" nonce=\"{nonce}\">{}</script>", script_json(block)));
    }
    // Speculation Rules: Chromium prerenders /k/* and /stadt/* on intent.
    h.push_str(&format!(
        "<script type=\"speculationrules\" nonce=\"{nonce}\">{}</script>",
        r#"{"prerender":[{"where":{"or":[{"href_matches":"/k/*"},{"href_matches":"/stadt/*"}]},"eagerness":"moderate"}]}"#
    ));
    // Hydration bootstrap must precede the client module (dioxus-web reads
    // these globals at startup).
    h.push_str(&format!(
        "<script nonce=\"{nonce}\">window.hydrate_queue=[];window.initial_dioxus_hydration_data=\"{}\";</script>",
        hydration_data()
    ));
    if !page.assets.client_js.is_empty() {
        h.push_str(&format!(
            "<script type=\"module\" nonce=\"{nonce}\">import init from \"{}\";init({{module_or_path:\"{}\"}});</script>",
            e(&page.assets.client_js),
            e(&page.assets.client_wasm)
        ));
    }
    h.push_str("</head>");

    let body_class = if page.full_bleed { "h-dvh overflow-hidden" } else { "min-h-dvh" };
    h.push_str(&format!("<body class=\"{body_class}\">"));
    h.push_str(&to_html(rsx! { Header { lang, path: bare_path.clone(), nav: page.nav, user: page.user.clone() } }));
    let main_class =
        if page.full_bleed { "absolute inset-0 top-[var(--header-h)]" } else { "mx-auto w-full max-w-5xl px-4 py-8" };
    h.push_str(&format!("<main class=\"{main_class}\">"));
    h.push_str(&body);
    h.push_str("</main>");
    if !page.full_bleed {
        h.push_str(&to_html(rsx! { Footer { lang } }));
    }
    h.push_str("</body></html>");
    h
}

#[component]
fn NavLink(href: String, active: bool, label: String) -> Element {
    let class = if active {
        "font-display text-sm tracking-wider uppercase transition-colors text-neon-pink"
    } else {
        "font-display text-sm tracking-wider uppercase transition-colors text-fg-muted hover:text-fg"
    };
    rsx! { a { href: "{href}", class: "{class}", "{label}" } }
}

#[component]
fn Header(lang: Lang, path: String, nav: Nav, user: Option<SessionUser>) -> Element {
    let is_mod = user.as_ref().is_some_and(|u| u.role.is_moderator());
    rsx! {
        header { class: "sticky top-0 z-40 h-[var(--header-h)] border-b-2 border-border bg-bg/95 backdrop-blur",
            div { class: "mx-auto flex h-full w-full max-w-7xl items-center gap-6 px-4",
                a { href: path_for_lang("/", lang), class: "font-display text-xl tracking-wide text-fg",
                    "TRINKHALLEN"
                    span { class: "text-neon-pink", "." }
                    "APP"
                }
                nav { class: "hidden flex-1 items-center gap-4 sm:flex",
                    NavLink { href: path_for_lang("/", lang), active: nav == Nav::Map, label: t(lang, "nav.map") }
                    NavLink { href: path_for_lang("/about", lang), active: nav == Nav::About, label: t(lang, "nav.about") }
                    if is_mod {
                        NavLink { href: path_for_lang("/moderate", lang), active: nav == Nav::Moderate, label: t(lang, "nav.mod") }
                    }
                }
                div { class: "flex flex-1 items-center justify-end gap-3 sm:flex-none",
                    LanguageSwitcher { lang, path: path.clone() }
                    button {
                        r#type: "button",
                        aria_label: t(lang, "nav.themeToggle"),
                        class: "cursor-pointer text-fg-muted transition-colors hover:text-neon-pink",
                        "data-theme-toggle": "",
                        // Glyph = the mode you'd switch TO; the client swaps it after load.
                        span { "data-theme-icon": "", "☾" }
                    }
                    match &user {
                        Some(u) => rsx! { UserButton { user: u.clone(), lang } },
                        None => rsx! {
                            a {
                                href: path_for_lang("/me", lang),
                                class: "border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg transition-colors hover:border-neon-pink hover:text-neon-pink",
                                "Login"
                            }
                        },
                    }
                }
            }
        }
    }
}

/// Compact DE/EN toggle; each language links to the same page in that locale.
#[component]
fn LanguageSwitcher(lang: Lang, path: String) -> Element {
    rsx! {
        div { class: "flex items-center gap-1 font-display text-xs tracking-wider uppercase",
            for (i, l) in SUPPORTED_LANGS.iter().copied().enumerate() {
                if i > 0 {
                    span { class: "text-border-hi", "/" }
                }
                if l == lang {
                    span { class: "text-neon-pink", "{l.code()}" }
                } else {
                    a {
                        href: format!("{}?setlang={}", path_for_lang(&path, l), l.code()),
                        hreflang: l.code(),
                        class: "text-fg-muted transition-colors hover:text-neon-pink",
                        "{l.code()}"
                    }
                }
            }
        }
    }
}

/// Every account has an auto-generated handle; no SSO profile data is shown.
#[component]
fn UserButton(user: SessionUser, lang: Lang) -> Element {
    let href = path_for_lang("/me", lang);
    match user.username {
        Some(name) => {
            let initial: String = name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
            rsx! {
                a {
                    href: "{href}",
                    class: "group inline-flex items-center gap-2 border-2 border-border-hi px-2 py-1 transition-colors hover:border-neon-pink",
                    aria_label: "Profil von @{name}",
                    span { class: "grid h-6 w-6 place-items-center bg-neon-pink/15 font-display text-xs text-neon-pink", "{initial}" }
                    span { class: "hidden font-mono text-sm lowercase text-neon-cyan transition-colors group-hover:text-neon-pink sm:inline", "@{name}" }
                }
            }
        }
        // Brief pre-backfill edge where a row still lacks a handle.
        None => rsx! {
            a {
                href: "{href}",
                class: "group relative inline-flex items-center gap-2 border-2 border-border-hi px-2 py-1 transition-colors hover:border-neon-pink",
                title: "Username noch nicht gewählt",
                aria_label: "Profil — Username noch nicht gewählt",
                span { class: "relative grid h-6 w-6 place-items-center border border-border bg-bg font-display text-xs text-fg-muted transition-colors group-hover:border-neon-pink group-hover:text-neon-pink",
                    span { aria_hidden: "true", "◉" }
                    span { class: "-top-px -right-px absolute h-1.5 w-1.5 bg-neon-amber", aria_hidden: "true" }
                }
                span { class: "hidden font-display text-sm tracking-wide uppercase text-fg-muted transition-colors group-hover:text-neon-pink sm:inline", "Profil" }
            }
        },
    }
}

#[component]
fn Footer(lang: Lang) -> Element {
    let link = "underline-offset-2 hover:text-neon-cyan hover:underline";
    rsx! {
        footer { class: "mt-16 border-t-2 border-border",
            div { class: "mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-fg-dim sm:flex-row sm:items-center sm:justify-between",
                p {
                    "{t(lang, \"footer.dataLicense\")} · "
                    a { class: link, href: path_for_lang("/about", lang), {t(lang, "footer.aboutContribute")} }
                }
                nav { class: "flex flex-wrap gap-x-4 gap-y-1",
                    a { class: link, href: path_for_lang("/impressum", lang), {t(lang, "footer.imprint")} }
                    a { class: link, href: path_for_lang("/datenschutz", lang), {t(lang, "footer.privacy")} }
                    a { class: link, href: "https://app.hopfenstop.de/", "HopfenStop" }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::AssetUrls;

    #[test]
    fn document_shell() {
        let mut page = Page::new(Lang::En, "/en/about", "n0nce", AssetUrls::default());
        page.title = Some("About".into());
        page.canonical_url = Some("https://trinkhallen.app/about".into());
        page.json_ld = vec![serde_json::json!({"name": "</script>"})];
        let html = render_document(&page, "<p>hi</p>".into());
        assert!(html.starts_with("<!DOCTYPE html><html lang=\"en\" data-theme=\"dark\">"));
        assert!(html.contains("<link rel=\"canonical\" href=\"https://trinkhallen.app/en/about\"/>"));
        assert!(html.contains("hreflang=\"de\" href=\"https://trinkhallen.app/about\""));
        assert!(html.contains("hreflang=\"x-default\" href=\"https://trinkhallen.app/about\""));
        assert!(html.contains("<title>About · TRINKHALLEN.APP</title>"));
        assert!(html.contains("\\u003c/script>"), "JSON-LD must not close its script tag");
        assert!(html.contains("nonce=\"n0nce\""));
        assert!(html.contains("window.initial_dioxus_hydration_data=\""));
        assert!(html.contains("<p>hi</p>"));
        assert!(html.contains("href=\"/en/impressum\""), "footer links localized");
        assert!(html.contains("href=\"/about?setlang=de\""), "switcher targets the other locale");
        assert!(html.contains(">Login<"));
    }
}
