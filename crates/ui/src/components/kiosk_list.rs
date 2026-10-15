//! Kiosk list: the side-panel list, also served as the
//! `/api/kiosks/panel` fragment and reused by `/stadt/:slug`.
//!
//! The list borrows its kiosk records for the duration of the render, so the
//! rows are plain functions returning [`Element`] rather than Dioxus
//! components (component props must be `'static`).

use dioxus::prelude::*;
use trinkhallen_core::geo::{LatLng, format_distance, haversine_meters};
use trinkhallen_core::hours::{Status, compute_kiosk_status, format_status};
use trinkhallen_core::i18n::{Lang, path_for_lang, payment_label, t, tag_label, tpl};
use trinkhallen_core::navigate::build_navigate_targets;
use trinkhallen_core::record::KioskRecord;

use crate::pages::PanelData;
use crate::render::to_html;

/// Row indicators surface things a user scans for at a glance: can I pay with
/// a card (girocard counts; see core::filters), is there a toilet. "Bar" and
/// "Kontaktlos" used to live here too — dropped because cash is the default
/// expectation and contactless is now folded into "Karte".
const CARD_KEYS: [&str; 3] = ["cards", "contactless", "girocard"];

pub fn render(data: &PanelData) -> String {
    to_html(panel(data))
}

fn panel(data: &PanelData) -> Element {
    let lang = data.lang;
    let is_filtered = data.filtered_count != data.total_in_bbox || data.filter_active;
    let count_label = if data.filtered_count == data.total_in_bbox {
        let suffix = if data.filtered_count == 1 {
            ""
        } else if lang == Lang::En {
            "s"
        } else {
            "n"
        };
        tpl(
            lang,
            "kioskList.countAll",
            &[("n", &data.filtered_count), ("suffix", &suffix)],
        )
    } else {
        tpl(
            lang,
            "kioskList.countFiltered",
            &[
                ("filtered", &data.filtered_count),
                ("total", &data.total_in_bbox),
            ],
        )
    };
    let reset_href = data.reset_href.clone().unwrap_or_default();

    if data.kiosks.is_empty() {
        return rsx! {
            div { class: "p-6 text-fg-muted",
                p { class: "font-display text-xl tracking-wide text-fg", "{t(lang, \"kioskList.nothingFound\")}" }
                p { class: "mt-2 text-sm", "{t(lang, \"kioskList.nothingHint\")}" }
                if is_filtered && data.reset_href.is_some() {
                    a {
                        href: "{reset_href}",
                        class: "mt-3 inline-block text-sm text-neon-cyan underline underline-offset-2",
                        "{t(lang, \"kioskList.resetLong\")}"
                    }
                }
            }
        };
    }

    let open_now = data.open_now_count.filter(|n| *n > 0);
    rsx! {
        // The scrolling parent is the `<aside data-sidebar>` two levels up: a
        // single scroll container per device, which Safari Mobile is happy to
        // drive with native flicks. The aside owns its own sticky chip header,
        // so this count row stays inline.
        div { class: "block",
            div { class: "flex items-center justify-between border-b-2 border-border px-4 py-2 text-xs uppercase tracking-wider",
                span { class: if is_filtered { "text-neon-pink" } else { "text-fg-dim" },
                    "{count_label}"
                    if let Some(n) = open_now {
                        span { class: "ml-2 text-status-open",
                            "▶▶▶ {tpl(lang, \"kioskList.openNow\", &[(\"n\", &n)])}"
                        }
                    }
                }
                if is_filtered && data.reset_href.is_some() {
                    a {
                        href: "{reset_href}",
                        class: "text-fg-muted hover:text-neon-pink",
                        aria_label: "{t(lang, \"kioskList.resetAria\")}",
                        "{t(lang, \"kioskList.resetShort\")}"
                    }
                }
            }
            ul { class: "divide-y-2 divide-border",
                for k in &data.kiosks {
                    {row(k, lang, data.origin, data.user_agent.as_deref())}
                }
            }
        }
    }
}

fn row(
    kiosk: &KioskRecord,
    lang: Lang,
    origin: Option<LatLng>,
    user_agent: Option<&str>,
) -> Element {
    let status = compute_kiosk_status(kiosk, chrono::Utc::now());
    let status_label = format_status(lang, status);
    let nav = build_navigate_targets(&kiosk.name, kiosk.lat, kiosk.lng, user_agent);

    let street_line = match (kiosk.addr("street"), kiosk.addr("number")) {
        (Some(s), Some(n)) => Some(format!("{s} {n}")),
        (Some(s), None) => Some(s.to_owned()),
        _ => None,
    };
    let addr = [street_line, kiosk.addr("district").map(str::to_owned)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    let dist_label = origin.map(|o| {
        format_distance(haversine_meters(
            o,
            LatLng {
                lat: kiosk.lat,
                lng: kiosk.lng,
            },
        ))
    });

    let accepts_card = CARD_KEYS.iter().any(|k| kiosk.pays(k) == Some("yes"));
    let has_wc = kiosk.tags.iter().any(|t| t == "wc");
    let has_seating = kiosk.tags.iter().any(|t| t == "sitzgelegenheiten");
    let has_terrace = kiosk.tags.iter().any(|t| t == "draussen");
    let any_icon = accepts_card || has_wc || has_seating || has_terrace;

    let (glyph, status_cls) = match status {
        Status::Open { .. } => ("▶▶▶ ", "text-status-open"),
        Status::Closed { .. } => ("■ ", "text-fg-dim"),
        Status::Unknown => ("… ", "text-fg-muted"),
    };
    let href = path_for_lang(&format!("/k/{}", kiosk.id), lang);
    let name = kiosk.name.as_str();
    let (lat, lng) = (kiosk.lat, kiosk.lng);

    rsx! {
        li {
            div { class: "flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-surface-2",
                a {
                    href: "{href}",
                    "data-lng": "{lng}",
                    "data-lat": "{lat}",
                    class: "flex-1 min-w-0",
                    p { class: "truncate font-display text-base tracking-wide text-fg", "{name}" }
                    if !addr.is_empty() {
                        p { class: "truncate text-sm text-fg-muted", "{addr}" }
                    }
                    div { class: "mt-1 flex flex-wrap items-center gap-1.5 text-xs",
                        span { class: "{status_cls}", "{glyph}{status_label}" }
                        if let Some(key) = kiosk.kind.badge_key() {
                            span { class: "border border-neon-amber px-1 font-display text-[0.65rem] tracking-wider uppercase text-neon-amber", "{t(lang, key)}" }
                        }
                        if let Some(d) = dist_label {
                            span {
                                class: "font-mono tabular-nums text-neon-cyan",
                                aria_label: "{t(lang, \"kioskList.distanceAria\")}",
                                "· {d}"
                            }
                        }
                        if any_icon {
                            span { class: "flex items-center gap-1 text-fg-dim",
                                if accepts_card {
                                    span {
                                        aria_label: "{payment_label(lang, \"cards\")}",
                                        title: "{payment_label(lang, \"cards\")}",
                                        "💳"
                                    }
                                }
                                if has_seating {
                                    span {
                                        aria_label: "{tag_label(lang, \"sitzgelegenheiten\")}",
                                        title: "{tag_label(lang, \"sitzgelegenheiten\")}",
                                        "🪑"
                                    }
                                }
                                if has_terrace {
                                    span {
                                        aria_label: "{tag_label(lang, \"draussen\")}",
                                        title: "{tag_label(lang, \"draussen\")}",
                                        "⛱️"
                                    }
                                }
                                if has_wc {
                                    span {
                                        aria_label: "{tag_label(lang, \"wc\")}",
                                        title: "{tag_label(lang, \"wc\")}",
                                        "🚻"
                                    }
                                }
                            }
                        }
                    }
                }
                a {
                    href: "{nav.primary.href}",
                    class: "shrink-0 border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink",
                    aria_label: "{tpl(lang, \"kioskList.navTo\", &[(\"name\", &name)])}",
                    "{t(lang, \"kioskList.nav\")}"
                }
            }
        }
    }
}
