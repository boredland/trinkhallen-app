//! City names and JSON-LD builders shared by the map, city and kiosk pages.

use serde_json::{Map, Value, json};
use trinkhallen_core::ORIGIN;
use trinkhallen_core::i18n::{Lang, t, tpl};
use trinkhallen_core::record::KioskRecord;

use crate::model::Aggregate;

/// Human-readable German names for the per-city landing pages. Slugs not in
/// this table fall back to the capitalised slug.
const CITY_DISPLAY: &[(&str, &str)] = &[
    ("frankfurt", "Frankfurt am Main"),
    ("koeln", "Köln"),
    ("duesseldorf", "Düsseldorf"),
    ("muenchen", "München"),
    ("nuernberg", "Nürnberg"),
    ("muenster", "Münster"),
    ("osnabrueck", "Osnabrück"),
    ("saarbruecken", "Saarbrücken"),
    ("goettingen", "Göttingen"),
    ("luebeck", "Lübeck"),
    ("wuerzburg", "Würzburg"),
    ("halle", "Halle (Saale)"),
    ("ruhr", "Ruhrgebiet"),
];

pub fn city_display_name(slug: &str) -> String {
    match CITY_DISPLAY.iter().find(|(s, _)| *s == slug) {
        Some((_, name)) => name.to_string(),
        None => {
            let mut c = slug.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        }
    }
}

/// Trailing segment of `kiosk.region` (e.g. `de/hessen/frankfurt` →
/// `frankfurt`), the slug that matches `/stadt/:slug`.
pub fn city_slug(kiosk: &KioskRecord) -> Option<&str> {
    kiosk
        .region
        .split('/')
        .next_back()
        .filter(|s| !s.is_empty())
}

pub fn kiosk_headline(lang: Lang, kiosk: &KioskRecord) -> String {
    match kiosk.addr("city") {
        Some(city) => tpl(
            lang,
            "page.kiosk.headline",
            &[("name", &kiosk.name), ("city", &city)],
        ),
        None => kiosk.name.clone(),
    }
}

pub fn kiosk_description(lang: Lang, kiosk: &KioskRecord) -> String {
    let city = kiosk.addr("city");
    let district = kiosk.addr("district");
    let where_ = match (district, city) {
        (Some(d), Some(c)) => format!("{d}, {c}"),
        (_, Some(c)) => c.to_owned(),
        _ => t(lang, "page.kiosk.germany"),
    };
    let hours = if kiosk.hours_raw().is_some() {
        t(lang, "page.kiosk.hours")
    } else {
        t(lang, "page.kiosk.hoursHint")
    };
    tpl(
        lang,
        "page.kiosk.description",
        &[("name", &kiosk.name), ("where", &where_), ("hours", &hours)],
    )
}

fn payment_to_schema(key: &str) -> Option<&'static str> {
    Some(match key {
        "cash" => "Cash",
        "cards" => "CreditCard",
        "girocard" => "DebitCard",
        "contactless" => "ContactlessPayment",
        _ => return None,
    })
}

pub fn kiosk_json_ld(kiosk: &KioskRecord, aggregate: Option<&Aggregate>) -> Value {
    let url = format!("{ORIGIN}/k/{}", kiosk.id);
    let mut address = Map::new();
    address.insert("@type".into(), json!("PostalAddress"));
    match (kiosk.addr("street"), kiosk.addr("number")) {
        (Some(street), Some(number)) => {
            address.insert("streetAddress".into(), json!(format!("{street} {number}")));
        }
        (Some(street), None) => {
            address.insert("streetAddress".into(), json!(street));
        }
        _ => {}
    }
    if let Some(p) = kiosk.addr("postalcode") {
        address.insert("postalCode".into(), json!(p));
    }
    if let Some(c) = kiosk.addr("city") {
        address.insert("addressLocality".into(), json!(c));
    }
    if let Some(d) = kiosk.addr("district") {
        address.insert("addressRegion".into(), json!(d));
    }
    address.insert("addressCountry".into(), json!("DE"));

    let mut business = Map::new();
    business.insert("@context".into(), json!("https://schema.org"));
    business.insert("@type".into(), json!("ConvenienceStore"));
    business.insert("@id".into(), json!(url));
    business.insert("url".into(), json!(url));
    business.insert("name".into(), json!(kiosk.name));
    business.insert("address".into(), Value::Object(address));
    business.insert(
        "geo".into(),
        json!({"@type": "GeoCoordinates", "latitude": kiosk.lat, "longitude": kiosk.lng}),
    );
    if let Some(raw) = kiosk.hours_raw() {
        business.insert("openingHours".into(), json!(raw));
    }
    if let Some(payment) = &kiosk.payment {
        let accepted: Vec<&str> = payment
            .iter()
            .filter(|(_, v)| v.as_str() == "yes")
            .filter_map(|(k, _)| payment_to_schema(k))
            .collect();
        if !accepted.is_empty() {
            business.insert("paymentAccepted".into(), json!(accepted.join(", ")));
        }
    }
    if let Some(agg) = aggregate.filter(|a| a.count > 0) {
        business.insert(
            "aggregateRating".into(),
            json!({
                "@type": "AggregateRating",
                "ratingValue": format!("{:.1}", agg.avg),
                "ratingCount": agg.count,
                "bestRating": 5,
                "worstRating": 1,
            }),
        );
    }
    Value::Object(business)
}

pub fn kiosk_breadcrumb_json_ld(kiosk: &KioskRecord) -> Value {
    let mut items = vec![
        json!({"@type": "ListItem", "position": 1, "name": "Trinkhallen", "item": format!("{ORIGIN}/")}),
    ];
    if let Some(stub) = city_slug(kiosk) {
        items.push(json!({
            "@type": "ListItem",
            "position": 2,
            "name": city_display_name(stub),
            "item": format!("{ORIGIN}/stadt/{stub}"),
        }));
    }
    items.push(json!({
        "@type": "ListItem",
        "position": items.len() + 1,
        "name": kiosk.name,
        "item": format!("{ORIGIN}/k/{}", kiosk.id),
    }));
    json!({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items})
}

pub fn homepage_json_ld() -> Vec<Value> {
    vec![
        json!({
            "@context": "https://schema.org",
            "@type": "WebSite",
            "@id": format!("{ORIGIN}/#website"),
            "url": format!("{ORIGIN}/"),
            "name": "trinkhallen.app",
            "description": "Trinkhallen, Wasserhäuschen und Spätis in Deutschland — offen, durchsuchbar, von der Community gepflegt.",
            "inLanguage": "de-DE",
        }),
        json!({
            "@context": "https://schema.org",
            "@type": "Organization",
            "@id": format!("{ORIGIN}/#organization"),
            "name": "trinkhallen.app",
            "url": format!("{ORIGIN}/"),
            "logo": format!("{ORIGIN}/apple-touch-icon.svg"),
            "sameAs": [
                "https://github.com/boredland/trinkhallen-app",
                "https://github.com/boredland/trinkhallen-data",
            ],
        }),
    ]
}

/// `de-DE`/`en-GB` grouped thousands, matching `Number.toLocaleString`
/// (`.` groups in German, `,` in English).
pub fn format_locale(n: impl std::fmt::Display, lang: Lang) -> String {
    let plain = n.to_string();
    let (int, frac) = match plain.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (plain.as_str(), None),
    };
    let negative = int.starts_with('-');
    let digits: String = int.chars().filter(|c| c.is_ascii_digit()).collect();
    let group = if lang == Lang::De { '.' } else { ',' };
    let mut out = String::with_capacity(plain.len() + 8);
    if negative {
        out.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(group);
        }
        out.push(c);
    }
    if let Some(f) = frac {
        out.push('.');
        out.push_str(f);
    }
    out
}

/// `dd.mm.yyyy` (de) / `dd/mm/yyyy` (en) for a unix timestamp, as
/// `toLocaleDateString(INTL_LOCALE[lang], {day: 2-digit, month: 2-digit, year: numeric})`.
pub fn fmt_date(unix: i64, lang: Lang) -> String {
    use chrono::Datelike;
    let d = chrono::DateTime::from_timestamp(unix, 0).map(|dt| dt.date_naive());
    let Some(d) = d else { return String::new() };
    let sep = if lang == Lang::De { '.' } else { '/' };
    format!("{:02}{}{:02}{}{}", d.day(), sep, d.month(), sep, d.year())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Aggregate;

    fn record() -> KioskRecord {
        use std::collections::BTreeMap;
        use trinkhallen_core::kind::KioskKind;
        let mut address = BTreeMap::new();
        address.insert("city".into(), "Frankfurt am Main".into());
        address.insert("district".into(), "Bornheim".into());
        KioskRecord {
            id: "tk_fr_1".into(),
            region: "de/hessen/frankfurt".into(),
            name: "Testkiosk".into(),
            description: None,
            address,
            hours: None,
            tags: Vec::new(),
            payment: None,
            lng: 8.7,
            lat: 50.1,
            sources: None,
            updated_at: 0,
            updated: None,
            kind: KioskKind::Kiosk,
        }
    }

    #[test]
    fn city_names() {
        assert_eq!(city_display_name("frankfurt"), "Frankfurt am Main");
        assert_eq!(city_display_name("koeln"), "Köln");
        assert_eq!(city_display_name("dortmund"), "Dortmund");
    }

    #[test]
    fn kiosk_head_and_tail() {
        let r = record();
        assert_eq!(city_slug(&r), Some("frankfurt"));
        assert_eq!(
            kiosk_headline(Lang::De, &r),
            "Testkiosk — Späti in Frankfurt am Main"
        );
        assert_eq!(
            kiosk_description(Lang::De, &r),
            "Testkiosk in Bornheim, Frankfurt am Main — Öffnungszeiten (Hinweise willkommen), Zahlungsmethoden und ein Klick zur Navigation auf trinkhallen.app."
        );
    }

    #[test]
    fn json_ld_shapes() {
        let r = record();
        let agg = Aggregate {
            avg: 4.5,
            count: 2,
            histogram: [0, 0, 0, 1, 1],
        };
        let v = kiosk_json_ld(&r, Some(&agg));
        assert_eq!(v["@type"], "ConvenienceStore");
        assert_eq!(v["address"]["addressLocality"], "Frankfurt am Main");
        assert_eq!(v["aggregateRating"]["ratingValue"], "4.5");
        let b = kiosk_breadcrumb_json_ld(&r);
        let items = b["itemListElement"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["name"], "Frankfurt am Main");
        assert_eq!(items[2]["item"], "https://trinkhallen.app/k/tk_fr_1");
    }

    #[test]
    fn numbers_and_dates() {
        assert_eq!(format_locale(1234567, Lang::De), "1.234.567");
        assert_eq!(format_locale(1234567, Lang::En), "1,234,567");
        assert_eq!(fmt_date(0, Lang::De), "01.01.1970");
        assert_eq!(fmt_date(0, Lang::En), "01/01/1970");
    }
}
