//! `/k/:id`: the kiosk detail article (sheet partial and standalone place
//! page) and the "kiosk not found" page.

use dioxus::prelude::*;
use trinkhallen_core::ORIGIN;
use trinkhallen_core::i18n::{Lang, path_for_lang, t};
use trinkhallen_core::navigate::js_num;

use crate::components::shared::{
    city_display_name, city_slug, kiosk_breadcrumb_json_ld, kiosk_description, kiosk_headline,
    kiosk_json_ld,
};
use crate::model::{Aggregate, Nav, RatingComment, RatingRow};
use crate::pages::{KioskDetailData, PageMeta};
use crate::render::{ClientEntry, to_html};

/// Kiosk detail — the `<article>`, for `?partial=1` and for embedding.
pub fn detail(data: &KioskDetailData) -> String {
    crate::components::kiosk_detail::render(data)
}

/// The rating block on its own: the body of `POST /api/ratings` responses with
/// `X-Tk-Fragment: 1`. Byte-identical to the block the detail page embeds, so
/// the client's `outerHTML` swap behaves identically.
pub fn rating_block(
    lang: Lang,
    kiosk_id: &str,
    aggregate: &Aggregate,
    own: Option<&RatingRow>,
    comments: &[RatingComment],
    is_logged_in: bool,
) -> String {
    let props = crate::islands::rating::RatingProps::new(
        lang,
        kiosk_id,
        *aggregate,
        own.cloned(),
        comments,
        is_logged_in,
    );
    crate::islands::rating::render_fragment(&props)
}

/// Direct `GET /k/:id`: breadcrumb + detail + the "on the map" link
/// link.
pub fn standalone(data: &KioskDetailData) -> (String, PageMeta) {
    let lang = data.lang;
    let kiosk = data.kiosk;

    // The city crumb only renders for kiosks whose
    // region slug is one of the landing pages.
    let city_crumb = match (kiosk.addr("city"), city_slug(kiosk)) {
        (Some(_), Some(stub)) => {
            let href = path_for_lang(&format!("/stadt/{stub}"), lang);
            Some(rsx! {
                " · "
                a { class: "hover:text-neon-pink", href: "{href}", "{city_display_name(stub)}" }
            })
        }
        _ => None,
    };
    let home = path_for_lang("/", lang);
    let breadcrumb = to_html(rsx! {
        p { class: "mb-4 font-display text-sm uppercase tracking-wider text-fg-muted",
            a { class: "hover:text-neon-pink", href: "{home}", "Trinkhallen" }
            {city_crumb}
        }
    });

    let map_href = format!(
        "{}?c={},{}&z=16",
        path_for_lang("/", lang),
        js_num(kiosk.lat),
        js_num(kiosk.lng)
    );
    let map_link = to_html(rsx! {
        p { class: "mt-4",
            a {
                class: "text-neon-cyan underline underline-offset-2",
                href: "{map_href}",
                "▶ Auf der Karte ansehen"
            }
        }
    });

    let body = format!("{breadcrumb}{}{map_link}", detail(data));
    let meta = PageMeta {
        title: Some(kiosk_headline(lang, kiosk)),
        description: Some(kiosk_description(lang, kiosk)),
        canonical_url: Some(format!("{ORIGIN}/k/{}", kiosk.id)),
        json_ld: vec![
            kiosk_json_ld(kiosk, Some(&data.aggregate)),
            kiosk_breadcrumb_json_ld(kiosk),
        ],
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Map),
        ..Default::default()
    };
    (body, meta)
}

/// `GET /k/:id` for an unknown id (the `?partial=1` variant answers with plain
/// text in the worker).
pub fn not_found(lang: Lang, id: &str) -> (String, PageMeta) {
    let home = path_for_lang("/", lang);
    let body = to_html(rsx! {
        h1 { class: "font-display text-4xl tracking-wide text-fg", "{t(lang, \"notFound.heading\")}" }
        p { class: "mt-3 text-fg-muted",
            "{t(lang, \"notFound.idMissingPre\")} "
            code { class: "font-mono", "{id}" }
            " {t(lang, \"notFound.idMissingPost\")} "
            a { class: "text-neon-cyan underline underline-offset-2", href: "{home}", "{t(lang, \"notFound.backToMap\")}" }
        }
    });
    let meta = PageMeta {
        title: Some(t(lang, "page.notFound.title")),
        noindex: true,
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Map),
        ..Default::default()
    };
    (body, meta)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use trinkhallen_core::kind::KioskKind;
    use trinkhallen_core::record::KioskRecord;

    use super::*;
    use crate::model::{Aggregate, RatingComment, RatingRow};
    use crate::pages::KioskDetailData;

    fn kiosk() -> KioskRecord {
        let mut address = BTreeMap::new();
        address.insert("street".into(), "Bornheimer Landstraße".into());
        address.insert("number".into(), "1".into());
        address.insert("city".into(), "Frankfurt am Main".into());
        KioskRecord {
            id: "tk_fr_42".into(),
            region: "de/hessen/frankfurt".into(),
            name: "Testkiosk".into(),
            description: None,
            address,
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

    fn detail_data<'a>(k: &'a KioskRecord) -> KioskDetailData<'a> {
        KioskDetailData {
            lang: Lang::De,
            kiosk: k,
            user_agent: None,
            aggregate: Aggregate {
                avg: 4.5,
                count: 2,
                histogram: [0, 0, 0, 1, 1],
            },
            own_rating: Some(RatingRow {
                stars: 5,
                comment: Some("Super".into()),
                created_at: 0,
                updated_at: 0,
            }),
            rating_comments: vec![RatingComment {
                author: "@pfand_pirat".into(),
                stars: 5,
                comment: "Super".into(),
                updated_at: 0,
            }],
            is_logged_in: true,
            nearby: Vec::new(),
            user_reports: Vec::new(),
            is_public_holiday: false,
            now_unix: 1_760_000_000,
        }
    }

    #[test]
    fn detail_embeds_all_three_islands() {
        let k = kiosk();
        let html = detail(&detail_data(&k));
        assert!(
            html.starts_with("<article class=\"border-2 border-border bg-surface\">"),
            "{html}"
        );
        // Rating island root is the swap target of `POST /api/ratings`.
        assert!(
            html.contains("<div id=\"rating-block\" data-island=\"rating\" data-props="),
            "{html}"
        );
        assert!(html.contains("data-island=\"checkin\""), "{html}");
        assert!(html.contains("data-island=\"report\""), "{html}");
        assert!(html.contains("id=\"checkin-island\""), "{html}");
        assert!(html.contains("id=\"report-island\""), "{html}");
        // Headings + form actions stay where the client expects them.
        assert!(html.contains(">Bewertungen</h2>"), "{html}");
        assert!(
            html.contains("<form action=\"/api/ratings\" method=\"post\""),
            "{html}"
        );
        assert!(
            html.contains("<form action=\"/api/reports\" method=\"post\""),
            "{html}"
        );
        assert!(html.contains("data-back=\"\" class=\"block border-b-2 border-border px-6 py-3 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:text-neon-pink\">← Zurück zur Karte</a>"), "{html}");
    }

    #[test]
    fn rating_block_fragment_matches_embedded_block() {
        let k = kiosk();
        let d = detail_data(&k);
        let fragment = rating_block(
            Lang::De,
            &k.id,
            &d.aggregate,
            d.own_rating.as_ref(),
            &d.rating_comments,
            true,
        );
        assert!(
            fragment.starts_with("<div id=\"rating-block\" data-island=\"rating\""),
            "{fragment}"
        );
        // The same function backs the block inside the detail article.
        assert!(
            detail(&d).contains(&fragment),
            "fragment must be byte-identical to the embedded block"
        );
    }

    #[test]
    fn standalone_page_has_breadcrumb_and_map_link() {
        let k = kiosk();
        let (body, meta) = standalone(&detail_data(&k));
        assert!(body.contains("href=\"/\">Trinkhallen</a>"), "{body}");
        assert!(
            body.contains("href=\"/stadt/frankfurt\">Frankfurt am Main</a>"),
            "{body}"
        );
        assert!(body.contains("▶ Auf der Karte ansehen"), "{body}");
        assert!(
            body.contains("href=\"/?c=50.123,8.689&#38;z=16\""),
            "{body}"
        );
        assert_eq!(
            meta.title.as_deref(),
            Some("Testkiosk — Späti in Frankfurt am Main")
        );
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/k/tk_fr_42")
        );
        assert_eq!(meta.json_ld[0]["@type"], "ConvenienceStore");
        assert_eq!(meta.json_ld[1]["@type"], "BreadcrumbList");
    }

    #[test]
    fn not_found_page_is_noindex() {
        let (body, meta) = not_found(Lang::En, "tk_xx_1");
        assert!(body.contains("404 — kiosk not found"), "{body}");
        assert!(
            body.contains("<code class=\"font-mono\">tk_xx_1</code>"),
            "{body}"
        );
        assert!(meta.noindex);
        assert_eq!(meta.title.as_deref(), Some("Not found"));
    }
}
