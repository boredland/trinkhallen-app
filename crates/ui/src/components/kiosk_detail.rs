//! `KioskDetail.tsx`: the kiosk article, with the rating/checkin/report
//! islands embedded (they replace `RatingBlock`, `CheckinForm`, `ReportForm`).
//!
//! Island markup arrives as pre-rendered HTML (hydration markers included), so
//! the three island sections put `h2` + island into the section through
//! `dangerous_inner_html` — the section ends up with the exact child structure
//! the TS has, island wrapper and all.

use dioxus::prelude::*;
use trinkhallen_core::hours::{
    Status, compute_status, format_hours_table, format_status, has_ph_token, kiosk_state,
};
use trinkhallen_core::i18n::{Lang, oh_labels, path_for_lang, payment_label, t, tag_label, tpl};
use trinkhallen_core::navigate::build_navigate_targets;
use trinkhallen_core::record::KioskRecord;
use trinkhallen_core::tags::is_reportable_tag;

use crate::components::shared::fmt_date;
use crate::islands::{checkin, report};
use crate::pages::KioskDetailData;
use crate::render::to_html;

/// Payment badges in render order (`PAYMENT_ORDER` in the TS).
const PAYMENT_ORDER: [&str; 4] = ["cash", "cards", "contactless", "girocard"];

fn payment_icon(key: &str) -> Option<&'static str> {
    Some(match key {
        "cash" => "💶",
        "cards" => "💳",
        "contactless" => "📲",
        "girocard" => "🟦",
        _ => return None,
    })
}

/// The `<article>` both the map sheet (`?partial=1`) and the standalone page
/// embed.
pub fn render(data: &KioskDetailData) -> String {
    to_html(article(data))
}

fn article(data: &KioskDetailData) -> Element {
    let lang = data.lang;
    let kiosk: &KioskRecord = data.kiosk;
    let now = chrono::DateTime::from_timestamp(data.now_unix, 0).unwrap_or_else(chrono::Utc::now);
    let status = compute_status(kiosk.hours.as_ref(), now, kiosk_state(kiosk));
    let status_label = format_status(lang, status);
    // PH banner condition: today is a Bundesland holiday AND the kiosk has
    // some opening_hours AND those hours carry no explicit PH rule. The status
    // above stays as-is; Spätis are often the holiday exception, so guessing
    // either way is wrong half the time.
    let show_ph_banner =
        kiosk.hours_raw().is_some() && !has_ph_token(kiosk.hours_raw()) && data.is_public_holiday;
    let nav = build_navigate_targets(
        &kiosk.name,
        kiosk.lat,
        kiosk.lng,
        data.user_agent.as_deref(),
    );

    let addr_line1 = [kiosk.addr("street"), kiosk.addr("number")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let addr_line2 = [kiosk.addr("postalcode"), kiosk.addr("city")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let district = kiosk.addr("district");

    let hopfenstop_source = kiosk
        .sources
        .as_ref()
        .is_some_and(|s| s.iter().any(|s| s.ty == "hopfenstop"));
    let osm_source = kiosk
        .sources
        .as_ref()
        .and_then(|s| s.iter().find(|s| s.ty == "osm"))
        .map(|s| s.id.clone());

    // Only surface tags from the curated reportable vocabulary — legacy and
    // imported slugs aren't managed, so hide them.
    let managed_tags: Vec<&str> = kiosk
        .tags
        .iter()
        .map(String::as_str)
        .filter(|s| is_reportable_tag(s))
        .collect();

    // Computed lead sentence — only a fallback. A real, data-provided
    // description always wins, so we don't show both.
    let intro = match (kiosk.description.as_ref(), kiosk.addr("city"), district) {
        (Some(_), _, _) => None,
        (None, Some(city), Some(district)) => Some(tpl(
            lang,
            "kiosk.introCityDistrict",
            &[
                ("name", &kiosk.name),
                ("district", &district),
                ("city", &city),
            ],
        )),
        (None, Some(city), None) => Some(tpl(
            lang,
            "kiosk.introCity",
            &[("name", &kiosk.name), ("city", &city)],
        )),
        (None, None, _) => None,
    };
    let updated_date = if kiosk.updated_at > 0 {
        Some(fmt_date(kiosk.updated_at, lang))
    } else {
        None
    };

    let (glyph, status_cls) = match status {
        Status::Open { .. } => ("▶▶▶ ", "text-status-open"),
        Status::Closed { .. } => ("■ ", "text-fg-dim"),
        Status::Unknown => ("… ", "text-fg-muted"),
    };
    let home = path_for_lang("/", lang);

    let checkin_section = island_section(
        lang,
        "kiosk.wereYouHere",
        checkin::render_fragment(&checkin_props(data)),
    );
    let rating_section = island_section(
        lang,
        "kiosk.ratingsHeading",
        crate::pages::kiosk::rating_block(
            lang,
            &kiosk.id,
            &data.aggregate,
            data.own_rating.as_ref(),
            &data.rating_comments,
            data.is_logged_in,
        ),
    );
    let report_section = island_section(
        lang,
        "kiosk.dataWrong",
        report::render_fragment(&report_props(data)),
    );

    rsx! {
        article { class: "border-2 border-border bg-surface",
            a {
                href: "{home}",
                "data-back": "",
                class: "block border-b-2 border-border px-6 py-3 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:text-neon-pink",
                "{t(lang, \"kiosk.backToMap\")}"
            }
            header { class: "border-b-2 border-border p-6",
                p { class: "mb-3 font-display text-sm tracking-wider uppercase {status_cls}", "{glyph}{status_label}" }
                h1 { class: "font-display text-3xl tracking-wide text-fg sm:text-5xl", "{kiosk.name}" }
                p { class: "mt-3 text-fg-muted",
                    "{addr_line1}"
                    if !addr_line2.is_empty() {
                        span { class: "text-fg-dim", " · {addr_line2}" }
                    }
                    if let Some(d) = district {
                        span { class: "text-fg-dim", " · {d}" }
                    }
                }
            }

            section { class: "border-b-2 border-border p-6",
                a {
                    href: "{nav.primary.href}",
                    class: "btn-neon w-full sm:w-auto",
                    "data-navigate-primary": "",
                    "{t(lang, \"kiosk.navigate\")}"
                }
                details { class: "mt-3 text-sm text-fg-muted",
                    summary { class: "cursor-pointer hover:text-fg", "{t(lang, \"kiosk.openOtherMaps\")}" }
                    ul { class: "mt-2 space-y-1 pl-4",
                        li {
                            a { class: "text-neon-cyan underline underline-offset-2", href: "{nav.apple.href}", "{nav.apple.label}" }
                        }
                        li {
                            a { class: "text-neon-cyan underline underline-offset-2", href: "{nav.geo.href}", "{nav.geo.label}" }
                        }
                        li {
                            a {
                                class: "text-neon-cyan underline underline-offset-2",
                                href: "{nav.google.href}",
                                target: "_blank",
                                rel: "noopener noreferrer",
                                "{nav.google.label}"
                            }
                        }
                    }
                }
            }

            if let Some(intro) = intro {
                section { class: "border-b-2 border-border p-6 text-fg-muted",
                    p { class: "text-fg", "{intro}" }
                }
            }

            if kiosk.payment.is_some() {
                section { class: "border-b-2 border-border p-6",
                    h2 { class: "mb-3 font-display text-sm tracking-wider uppercase text-fg-muted",
                        "{t(lang, \"kiosk.paymentHeading\")}"
                    }
                    ul { class: "flex flex-wrap gap-2",
                        for key in PAYMENT_ORDER {
                            {
                                let value = kiosk.pays(key);
                                if value.is_none() {
                                    rsx! {}
                                } else {
                                    let icon = payment_icon(key).unwrap_or_default();
                                    let label = payment_label(lang, key);
                                    let cls = match value.unwrap_or("") {
                                        "yes" => "border-success/60 text-success",
                                        "no" => "border-border text-fg-dim line-through",
                                        _ => "border-border text-fg-muted",
                                    };
                                    rsx! {
                                        li {
                                            span { class: "inline-flex items-center gap-1.5 border-2 px-2 py-1 text-sm {cls}",
                                                span { aria_hidden: "true", "{icon}" }
                                                span { "{label}" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if let Some(raw) = kiosk.hours_raw() {
                section { class: "border-b-2 border-border p-6",
                    h2 { class: "mb-2 font-display text-sm tracking-wider uppercase text-fg-muted",
                        "{t(lang, \"kiosk.openingHoursHeading\")}"
                    }
                    if show_ph_banner {
                        p { class: "mb-3 border border-neon-amber/60 bg-neon-amber/10 px-3 py-2 text-sm text-fg",
                            "{t(lang, \"kiosk.phBanner\")}"
                        }
                    }
                    {
                        match format_hours_table(lang, Some(raw), kiosk_state(kiosk)) {
                            Some(rows) => rsx! {
                                dl { class: "grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm",
                                    for row in rows {
                                        dt { class: "text-fg-dim", "{row.days}" }
                                        dd {
                                            class: if row.hours == oh_labels(lang).closed_lower {
                                                "text-fg-muted"
                                            } else {
                                                "text-fg"
                                            },
                                            "{row.hours}"
                                        }
                                    }
                                }
                            },
                            None => rsx! { p { class: "font-mono text-fg", "{raw}" } },
                        }
                    }
                }
            }

            if let Some(description) = &kiosk.description {
                section { class: "border-b-2 border-border p-6",
                    h2 { class: "mb-2 font-display text-sm tracking-wider uppercase text-fg-muted",
                        "{t(lang, \"kiosk.descriptionHeading\")}"
                    }
                    p { class: "text-fg whitespace-pre-line", "{description}" }
                }
            }

            if !managed_tags.is_empty() {
                section { class: "border-b-2 border-border p-6",
                    h2 { class: "mb-3 font-display text-sm tracking-wider uppercase text-fg-muted",
                        "{t(lang, \"kiosk.tagsHeading\")}"
                    }
                    ul { class: "flex flex-wrap gap-2",
                        for slug in managed_tags {
                            li { class: "border-2 border-border-hi px-2 py-1 text-sm text-fg-muted", "{tag_label(lang, slug)}" }
                        }
                    }
                }
            }

            {checkin_section}
            {rating_section}
            {report_section}

            if !data.nearby.is_empty() {
                section { class: "border-b-2 border-border p-6",
                    h2 { class: "mb-3 font-display text-sm tracking-wider uppercase text-fg-muted",
                        "{t(lang, \"kiosk.nearbyHeading\")}"
                    }
                    ul { class: "space-y-2 text-sm",
                        for n in &data.nearby {
                            {
                                let distance = if n.distance < 1000.0 {
                                    format!("{} m", n.distance.round() as i64)
                                } else {
                                    format!("{:.1} km", n.distance / 1000.0)
                                };
                                let href = path_for_lang(&format!("/k/{}", n.id), lang);
                                rsx! {
                                    li { class: "flex items-baseline justify-between gap-3",
                                        a {
                                            href: "{href}",
                                            "data-lng": "{n.lng}",
                                            "data-lat": "{n.lat}",
                                            class: "text-fg underline-offset-2 hover:text-neon-pink hover:underline",
                                            "{n.name}"
                                            if let Some(d) = &n.district {
                                                span { class: "text-fg-dim", " · {d}" }
                                            }
                                        }
                                        span { class: "font-mono tabular-nums text-xs text-fg-dim", "{distance}" }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            footer { class: "flex flex-col gap-2 p-6 text-sm text-fg-dim sm:flex-row sm:items-center sm:justify-between",
                p {
                    span { class: "text-fg-muted", "{t(lang, \"kiosk.idLabel\")}" }
                    " "
                    code { class: "font-mono", "{kiosk.id}" }
                    if hopfenstop_source {
                        " · "
                        span { class: "text-fg-muted", "{t(lang, \"kiosk.sourceLabel\")}" }
                        " HopfenStop"
                    }
                    if let Some(osm_id) = osm_source {
                        " · "
                        span { class: "text-fg-muted", "{t(lang, \"kiosk.sourceLabel\")}" }
                        " "
                        a {
                            class: "underline-offset-2 hover:text-neon-cyan hover:underline",
                            href: "https://www.openstreetmap.org/{osm_id}",
                            target: "_blank",
                            rel: "noopener noreferrer",
                            "OpenStreetMap"
                        }
                        if let Some(updated) = updated_date {
                            " · "
                            span { class: "text-fg-muted", "{t(lang, \"kiosk.updatedLabel\")}" }
                            " {updated}"
                        }
                    }
                }
                a {
                    href: "https://github.com/boredland/trinkhallen-data/blob/main/data/{kiosk.region}.geojson",
                    target: "_blank",
                    rel: "noopener noreferrer",
                    class: "text-neon-cyan underline underline-offset-2",
                    "{t(lang, \"kiosk.editOnGithub\")}"
                }
            }
        }
    }
}

/// `<section>` wrapping a heading and one pre-rendered island.
fn island_section(lang: Lang, heading_key: &str, island_html: String) -> Element {
    let heading = to_html(rsx! {
        h2 { class: "mb-3 font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, heading_key)}" }
    });
    rsx! {
        section {
            class: "border-b-2 border-border p-6",
            dangerous_inner_html: "{heading}{island_html}",
        }
    }
}

fn checkin_props(data: &KioskDetailData) -> checkin::CheckinProps {
    let kiosk = data.kiosk;
    checkin::CheckinProps::new(
        data.lang,
        &kiosk.id,
        kiosk.hours_raw(),
        kiosk
            .payment
            .clone()
            .map(|p| p.into_iter().collect())
            .unwrap_or_default(),
        kiosk.tags.clone(),
        &kiosk.name,
        data.is_logged_in,
        data.user_reports.clone(),
    )
}

fn report_props(data: &KioskDetailData) -> report::ReportProps {
    report::ReportProps::new(
        data.lang,
        &data.kiosk.id,
        data.is_logged_in,
        data.kiosk.hours_raw(),
        &data.user_reports,
    )
}
