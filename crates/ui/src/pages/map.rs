//! `/` and the map view (`pages.tsx` `renderMapPage`): the MapLibre mount,
//! legal overlay, kiosk sheet + backdrop and the filter sidebar with the
//! `filters` island and the kiosk panel.

use dioxus::prelude::*;
use trinkhallen_core::ORIGIN;
use trinkhallen_core::geo::Bbox;
use trinkhallen_core::i18n::{path_for_lang, t};
use trinkhallen_core::navigate::js_num;

use crate::components::drag_handle::DragHandle;
use crate::components::shared::{
    homepage_json_ld, kiosk_breadcrumb_json_ld, kiosk_description, kiosk_headline, kiosk_json_ld,
};
use crate::islands::filters::{self, FilterIsland, FilterProps};
use crate::model::Nav;
use crate::pages::{MapData, PageMeta};
use crate::render::{ClientEntry, to_html};

/// Static bbox the map falls back to (`data-bbox` in the TS).
const DEFAULT_BBOX: &str = "5.87,47.27,15.04,55.06";

pub fn render(data: &MapData) -> (String, PageMeta) {
    let lang = data.lang;
    let sheet_open = data.focused.is_some();
    let focus_lng = data.focused.as_ref().map(|f| js_num(f.kiosk.lng));
    let focus_lat = data.focused.as_ref().map(|f| js_num(f.kiosk.lat));
    let initial_href = data.focused.as_ref().map(|f| f.href.clone());

    let filters_html = crate::render::island(
        "filter-island",
        filters::NAME,
        FilterIsland,
        FilterProps::new(lang, &data.filter, path_for_lang("/", lang)),
    );
    let panel_html = crate::pages::panel::render(&data.panel);
    let sheet_body = data
        .focused
        .as_ref()
        .map(|f| f.inner_html.clone())
        .unwrap_or_default();
    let initial_bbox = data
        .initial_bbox
        .map(format_bbox)
        .map(|b| format!("&bbox={b}"))
        .unwrap_or_default();
    let panel_url = format!("/api/kiosks/panel?lang={}{initial_bbox}", lang.code());

    let body = to_html(rsx! {
        div { class: "relative h-full w-full",
            div {
                id: "map",
                class: "h-full w-full bg-surface",
                "data-bbox": DEFAULT_BBOX,
                "data-filter-state": "{data.search}",
                "data-focus-lng": focus_lng,
                "data-focus-lat": focus_lat,
            }

            // Legal footer overlay — fullBleed hides the global Footer, but TMG
            // §5 expects the Impressum to be reachable from every page. Sits
            // bottom-left so it doesn't collide with MapLibre's attribution
            // control at bottom-right.
            nav { class: "pointer-events-none absolute bottom-2 left-2 z-10 flex gap-3 text-xs text-fg-dim/80",
                a {
                    class: "pointer-events-auto bg-bg/70 px-1.5 py-0.5 backdrop-blur-sm hover:text-neon-cyan",
                    href: "{path_for_lang(\"/impressum\", lang)}",
                    "Impressum"
                }
                a {
                    class: "pointer-events-auto bg-bg/70 px-1.5 py-0.5 backdrop-blur-sm hover:text-neon-cyan",
                    href: "{path_for_lang(\"/datenschutz\", lang)}",
                    "Datenschutz"
                }
            }

            // Backdrop is a sibling of the sheet (a transform ancestor would
            // make position: fixed resolve to its bounds, not the viewport).
            div {
                id: "kiosk-sheet-backdrop",
                class: "pointer-events-none fixed inset-0 z-20 bg-bg/60 opacity-0 transition-opacity duration-200 data-[open=true]:pointer-events-auto data-[open=true]:opacity-100",
                "data-open": "{sheet_open}",
            }
            div {
                id: "kiosk-sheet",
                class: "pointer-events-none fixed inset-x-0 bottom-0 z-30 translate-y-full transition-transform duration-200 ease-out data-[open=true]:pointer-events-auto data-[open=true]:translate-y-0 sm:top-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-md sm:translate-x-full sm:translate-y-0 sm:data-[open=true]:translate-x-0",
                "data-open": "{sheet_open}",
                "data-initial-href": initial_href,
                aria_hidden: "{!sheet_open}",
                div { class: "relative flex max-h-[90dvh] flex-col bg-surface border-t-2 border-border sm:h-full sm:max-h-none sm:border-l-2 sm:border-t-0",
                    DragHandle { label: "Sheet schließen — nach unten ziehen".to_string() }
                    button {
                        r#type: "button",
                        aria_label: "Schließen",
                        "data-sheet-close": "",
                        class: "absolute right-4 top-4 z-10 hidden h-8 w-8 cursor-pointer items-center justify-center border-2 border-border-hi font-display text-fg-muted hover:border-neon-pink hover:text-neon-pink sm:flex",
                        "×"
                    }
                    div {
                        id: "kiosk-sheet-body",
                        class: "min-h-0 flex-1 overflow-y-auto overscroll-contain",
                        dangerous_inner_html: "{sheet_body}",
                    }
                }
            }

            button {
                r#type: "button",
                "data-sidebar-expand": "",
                "data-show": "false",
                aria_label: "Filter einblenden",
                class: "pointer-events-auto absolute bottom-3 left-3 z-20 hidden cursor-pointer items-center gap-1.5 border-2 border-border bg-surface px-3 py-2 font-display text-sm tracking-wider uppercase text-fg hover:border-neon-pink hover:text-neon-pink data-[show=true]:flex sm:top-3 sm:bottom-auto",
                "☰ Filter"
            }

            aside {
                "data-sidebar": "",
                "data-collapsed": "false",
                class: "pointer-events-auto absolute inset-x-0 bottom-0 z-10 max-h-[80dvh] overflow-y-auto overscroll-contain border-t-2 border-border bg-surface/95 backdrop-blur transition-transform duration-200 ease-out [touch-action:pan-y] data-[collapsed=true]:translate-y-full sm:top-0 sm:left-0 sm:right-auto sm:max-h-none sm:w-[380px] sm:border-r-2 sm:border-t-0 sm:data-[collapsed=true]:translate-x-[-100%] sm:data-[collapsed=true]:translate-y-0",
                DragHandle { label: "Filter ausblenden — nach unten ziehen".to_string() }
                // The chip header stays sticky inside the scrolling aside; the
                // island + collapse button are its children.
                div {
                    class: "sticky top-0 z-10 border-b-2 border-border bg-surface p-3 sm:pr-10",
                    dangerous_inner_html: "{filters_html}{collapse_button()}",
                }
                a {
                    href: "{path_for_lang(\"/add\", lang)}",
                    class: "flex items-center justify-center gap-2 border-b-2 border-border bg-surface-2 px-3 py-2 font-display text-sm tracking-wider uppercase text-fg-muted transition-colors hover:text-neon-pink",
                    span { class: "text-neon-pink", "+" }
                    " Späti vorschlagen"
                }
                div {
                    id: "kiosk-panel",
                    "data-panel-url": "{panel_url}",
                    dangerous_inner_html: "{panel_html}",
                }
            }
        }
    });

    let meta = match &data.focused {
        Some(f) => PageMeta {
            title: Some(kiosk_headline(lang, f.kiosk)),
            description: Some(kiosk_description(lang, f.kiosk)),
            canonical_url: Some(format!("{ORIGIN}/k/{}", f.kiosk.id)),
            json_ld: vec![
                kiosk_json_ld(f.kiosk, None),
                kiosk_breadcrumb_json_ld(f.kiosk),
            ],
            entries: vec![ClientEntry::App, ClientEntry::Map],
            full_bleed: true,
            nav: Some(Nav::Map),
            ..Default::default()
        },
        None => PageMeta {
            title: Some(t(lang, "page.home.title")),
            description: Some(t(lang, "page.home.description")),
            canonical_url: Some(format!("{ORIGIN}/")),
            json_ld: homepage_json_ld(),
            entries: vec![ClientEntry::App, ClientEntry::Map],
            full_bleed: true,
            nav: Some(Nav::Map),
            ..Default::default()
        },
    };
    (body, meta)
}

/// Desktop-only collapse (← slides the sidebar off the left edge); on mobile
/// the drag handle above handles dismissal.
fn collapse_button() -> String {
    to_html(rsx! {
        button {
            r#type: "button",
            "data-sidebar-collapse": "",
            aria_label: "Filter ausblenden",
            class: "absolute right-1 top-1 hidden h-8 w-8 cursor-pointer items-center justify-center text-lg leading-none text-fg-dim transition-colors hover:text-neon-pink focus-visible:text-neon-pink focus-visible:outline-2 focus-visible:outline-neon-pink sm:flex",
            span { aria_hidden: "true", "←" }
        }
    })
}

/// `w,s,e,n` the way `URLSearchParams` would print it.
fn format_bbox(b: Bbox) -> String {
    format!(
        "{},{},{},{}",
        js_num(b.west),
        js_num(b.south),
        js_num(b.east),
        js_num(b.north)
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use trinkhallen_core::filters::KioskFilter;
    use trinkhallen_core::geo::Bbox;
    use trinkhallen_core::i18n::Lang;
    use trinkhallen_core::kind::KioskKind;
    use trinkhallen_core::record::KioskRecord;

    use super::*;
    use crate::pages::{FocusedKiosk, PanelData};

    fn kiosk() -> KioskRecord {
        KioskRecord {
            id: "tk_fr_42".into(),
            region: "de/hessen/frankfurt".into(),
            name: "Testkiosk".into(),
            description: None,
            address: BTreeMap::new(),
            hours: None,
            tags: Vec::new(),
            payment: None,
            lng: 8.689,
            lat: 50.123,
            sources: None,
            updated_at: 0,
            updated: None,
            kind: KioskKind::Kiosk,
        }
    }

    fn map_data<'a>(kiosks: Vec<&'a KioskRecord>) -> MapData<'a> {
        MapData {
            lang: Lang::De,
            filter: KioskFilter::default(),
            search: "?open_now=1".into(),
            focused: None,
            initial_bbox: Some(Bbox {
                west: 8.4,
                south: 50.0,
                east: 8.9,
                north: 50.3,
            }),
            panel: PanelData {
                lang: Lang::De,
                kiosks,
                total_in_bbox: 1,
                filtered_count: 1,
                open_now_count: None,
                filter_active: false,
                reset_href: None,
                origin: None,
                user_agent: None,
            },
        }
    }

    #[test]
    fn map_page_mounts_and_sidebar() {
        let k = kiosk();
        let (html, meta) = render(&map_data(vec![&k]));
        assert!(html.contains("<div id=\"map\" class=\"h-full w-full bg-surface\" data-bbox=\"5.87,47.27,15.04,55.06\" data-filter-state=\"?open_now=1\""), "{html}");
        assert!(
            !html.contains("data-focus-lng"),
            "no focus attrs without a focused kiosk: {html}"
        );
        // Legal overlay (fullBleed hides the footer chrome).
        assert!(html.contains("href=\"/impressum\">Impressum</a>"), "{html}");
        assert!(
            html.contains("href=\"/datenschutz\">Datenschutz</a>"),
            "{html}"
        );
        // Sheet + backdrop start closed.
        assert!(html.contains("id=\"kiosk-sheet-backdrop\""), "{html}");
        assert!(html.contains("id=\"kiosk-sheet\""), "{html}");
        assert!(html.contains("data-open=\"false\""), "{html}");
        // Sidebar: filters island, add link, panel with its fetch URL.
        assert!(html.contains("data-island=\"filters\""), "{html}");
        assert!(html.contains("data-filter-form"), "{html}");
        assert!(html.contains("href=\"/add\""), "{html}");
        assert!(html.contains("id=\"kiosk-panel\" data-panel-url=\"/api/kiosks/panel?lang=de&#38;bbox=8.4,50,8.9,50.3\""), "{html}");
        // Homepage head: title/description from the catalog + WebSite JSON-LD.
        assert_eq!(
            meta.title.as_deref(),
            Some("Trinkhallen, Spätis & Wasserhäuschen finden")
        );
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/")
        );
        assert_eq!(meta.json_ld.len(), 2);
        assert!(meta.full_bleed);
    }

    #[test]
    fn focused_map_page_opens_sheet_on_kiosk() {
        let k = kiosk();
        let mut data = map_data(vec![&k]);
        data.focused = Some(FocusedKiosk {
            kiosk: &k,
            inner_html: "<article id=\"x\">detail</article>".into(),
            href: "/k/tk_fr_42".into(),
        });
        let (html, meta) = render(&data);
        assert!(html.contains("data-focus-lng=\"8.689\""), "{html}");
        assert!(html.contains("data-focus-lat=\"50.123\""), "{html}");
        assert!(html.contains("data-open=\"true\""), "{html}");
        assert!(html.contains("data-initial-href=\"/k/tk_fr_42\""), "{html}");
        assert!(
            html.contains("<article id=\"x\">detail</article>"),
            "{html}"
        );
        assert_eq!(meta.title.as_deref(), Some("Testkiosk"));
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/k/tk_fr_42")
        );
    }
}
