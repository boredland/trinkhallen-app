//! `/stadt/:slug`: the per-city directory page and its 404.

use dioxus::prelude::*;
use serde_json::Value;
use trinkhallen_core::ORIGIN;
use trinkhallen_core::i18n::{Lang, path_for_lang, t, tpl};

use crate::components::shared::format_locale;
use crate::model::Nav;
use crate::pages::{CityData, PageMeta};
use crate::render::{ClientEntry, to_html};

pub fn render(data: &CityData) -> (String, PageMeta) {
    let lang = data.lang;
    let city = &data.city;
    let total_label = format_locale(data.total, lang);
    let home = path_for_lang("/", lang);
    let heading = tpl(lang, "city.heading", &[("city", city)]);
    let locations = tpl(
        lang,
        "city.locations",
        &[("total", &total_label), ("city", city)],
    );

    let header = to_html(rsx! {
        header {
            p { class: "font-display text-sm uppercase tracking-wider text-fg-muted",
                a { class: "hover:text-neon-pink", href: "{home}", "{t(lang, \"city.breadcrumb\")}" }
                " · {city}"
            }
            h1 { class: "mt-2 font-display text-4xl tracking-wide text-fg sm:text-6xl", "{heading}" }
            p { class: "mt-3 text-lg text-fg-muted",
                "{locations}"
                if data.open_now > 0 {
                    " "
                    span { class: "text-status-open",
                        "▶▶▶ {tpl(lang, \"city.openNow\", &[(\"n\", &data.open_now)])}"
                    }
                }
            }
            p { class: "mt-4",
                a { class: "btn-neon", href: "{data.map_href}", "{t(lang, \"city.viewOnMap\")}" }
            }
        }
    });

    // `KioskList` markup, pre-rendered as the panel fragment it also serves as.
    let list = crate::pages::panel::render(&crate::pages::PanelData {
        lang,
        kiosks: data.visible.clone(),
        total_in_bbox: data.total,
        filtered_count: data.total,
        open_now_count: Some(data.open_now),
        filter_active: false,
        reset_href: None,
        origin: None,
        user_agent: data.user_agent.clone(),
    });

    let tail = if data.total > data.visible.len() {
        let showing = tpl(
            lang,
            "city.showing",
            &[("visible", &data.visible.len()), ("total", &total_label)],
        );
        to_html(rsx! {
            p { class: "text-sm text-fg-dim",
                "{showing} "
                a {
                    class: "text-neon-cyan underline underline-offset-2",
                    href: "{data.map_href}",
                    "{t(lang, \"city.allOnMap\")}"
                }
            }
        })
    } else {
        String::new()
    };

    let body = to_html(rsx! {
        article {
            class: "space-y-6",
            dangerous_inner_html: "{header}{list}{tail}",
        }
    });

    let meta = PageMeta {
        title: Some(tpl(lang, "page.city.title", &[("city", city)])),
        description: Some(tpl(
            lang,
            "page.city.description",
            &[
                ("total", &total_label),
                ("city", city),
                ("openNow", &data.open_now),
            ],
        )),
        canonical_url: Some(format!("{ORIGIN}/stadt/{}", data.slug)),
        json_ld: vec![item_list_json_ld(data), breadcrumb_json_ld(data)],
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Map),
        ..Default::default()
    };
    (body, meta)
}

/// `GET /stadt/:slug` for a slug outside the dataset.
/// Copy is German in both locales.
pub fn not_found(lang: Lang, slug: &str) -> (String, PageMeta) {
    let home = path_for_lang("/", lang);
    let body = to_html(rsx! {
        h1 { class: "font-display text-4xl tracking-wide text-fg", "404 — Stadt nicht gefunden" }
        p { class: "mt-3 text-fg-muted",
            code { class: "font-mono", "{slug}" }
            " ist nicht in unserem Datensatz. "
            a { class: "text-neon-cyan underline underline-offset-2", href: "{home}", "Zurück zur Karte" }
        }
    });
    let meta = PageMeta {
        title: Some(t(lang, "page.cityNotFound.title")),
        noindex: true,
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Map),
        ..Default::default()
    };
    (body, meta)
}

fn item_list_json_ld(data: &CityData) -> Value {
    let items: Vec<Value> = data
        .visible
        .iter()
        .enumerate()
        .map(|(i, k)| {
            serde_json::json!({
                "@type": "ListItem",
                "position": i + 1,
                "url": format!("{ORIGIN}/k/{}", k.id),
                "name": k.name,
            })
        })
        .collect();
    serde_json::json!({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": format!("Trinkhallen, Spätis & Wasserhäuschen in {}", data.city),
        "numberOfItems": data.total,
        "itemListElement": items,
    })
}

fn breadcrumb_json_ld(data: &CityData) -> Value {
    serde_json::json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Trinkhallen", "item": format!("{ORIGIN}/")},
            {"@type": "ListItem", "position": 2, "name": data.city, "item": format!("{ORIGIN}/stadt/{}", data.slug)},
        ],
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use trinkhallen_core::kind::KioskKind;
    use trinkhallen_core::record::KioskRecord;

    use super::*;

    fn kiosk(id: &str, name: &str) -> KioskRecord {
        KioskRecord {
            id: id.into(),
            region: "de/hessen/frankfurt".into(),
            name: name.into(),
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

    fn city_data<'a>(visible: Vec<&'a KioskRecord>) -> CityData<'a> {
        CityData {
            lang: Lang::De,
            slug: "frankfurt".into(),
            city: "Frankfurt am Main".into(),
            total: 1200,
            open_now: 42,
            visible,
            map_href: "/?c=50.2300,8.5900&z=12".into(),
            user_agent: None,
        }
    }

    #[test]
    fn city_page_lists_and_links_to_the_map() {
        let a = kiosk("tk_fr_1", "Alpha");
        let b = kiosk("tk_fr_2", "Beta");
        let (body, meta) = render(&city_data(vec![&a, &b]));
        assert!(
            body.contains("href=\"/\">Trinkhallen</a> · Frankfurt am Main"),
            "{body}"
        );
        assert!(
            body.contains("Spätis &#38; Trinkhallen in Frankfurt am Main"),
            "{body}"
        );
        assert!(
            body.contains("1.200 Standorte in Frankfurt am Main."),
            "{body}"
        );
        assert!(body.contains("▶▶▶ 42 jetzt offen."), "{body}");
        assert!(
            body.contains("href=\"/?c=50.2300,8.5900&#38;z=12\">▶ Auf der Karte ansehen</a>"),
            "{body}"
        );
        // The KioskList rows are the panel fragment.
        assert!(body.contains("href=\"/k/tk_fr_1\""), "{body}");
        assert!(body.contains("href=\"/k/tk_fr_2\""), "{body}");
        // "2 von 1.200 angezeigt."
        assert!(body.contains("2 von 1.200 angezeigt."), "{body}");
        assert_eq!(
            meta.title.as_deref(),
            Some("Trinkhallen, Spätis & Wasserhäuschen in Frankfurt am Main")
        );
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/stadt/frankfurt")
        );
        assert_eq!(meta.json_ld[0]["@type"], "ItemList");
        assert_eq!(meta.json_ld[0]["numberOfItems"], 1200);
    }

    #[test]
    fn unknown_city_is_noindex_404() {
        let (body, meta) = not_found(Lang::De, "atlantis");
        assert!(body.contains("404 — Stadt nicht gefunden"), "{body}");
        assert!(
            body.contains("<code class=\"font-mono\">atlantis</code>"),
            "{body}"
        );
        assert!(body.contains("Zurück zur Karte"), "{body}");
        assert!(meta.noindex);
    }
}
