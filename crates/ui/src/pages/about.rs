//! `/about`: the German body inline here, the English
//! courtesy translation from `components::legal_prose`.

use dioxus::prelude::*;
use trinkhallen_core::ORIGIN;
use trinkhallen_core::i18n::{Lang, path_for_lang, t};

use crate::components::legal_prose;
use crate::components::shared::format_locale;
use crate::model::Nav;
use crate::pages::{AboutData, PageMeta};
use crate::render::{ClientEntry, to_html};

pub fn render(data: &AboutData) -> (String, PageMeta) {
    let lang = data.lang;
    let body = if lang == Lang::En {
        legal_prose::about_en(data.total as u64, data.ratings, data.users)
    } else {
        german_body(data)
    };
    let meta = PageMeta {
        title: Some(t(lang, "page.about.title")),
        description: Some(t(lang, "page.about.description")),
        canonical_url: Some(format!("{ORIGIN}/about")),
        entries: vec![ClientEntry::App],
        nav: Some(Nav::About),
        ..Default::default()
    };
    (body, meta)
}

fn metric(value: u64, label: &str) -> String {
    // Thousands separators follow `toLocaleString("de-DE")`.
    let value = format_locale(value, Lang::De);
    to_html(rsx! {
        div { class: "border-2 border-border bg-surface px-5 py-6 sm:px-6 sm:py-8",
            div { class: "font-display text-5xl text-neon-pink tabular-nums sm:text-6xl", "{value}" }
            div { class: "mt-2 text-sm uppercase tracking-wider text-fg-dim", "{label}" }
        }
    })
}

fn german_body(data: &AboutData) -> String {
    let lang = Lang::De;
    let total_label = format_locale(data.total, lang);
    let add_href = path_for_lang("/add", lang);
    let (ratings, users) = (data.ratings, data.users);
    let metrics = [
        metric(data.total as u64, "Trinkhallen kartiert"),
        metric(ratings, "Bewertungen abgegeben"),
        metric(users, "Registrierte Personen"),
    ]
    .join("");
    to_html(rsx! {
        article { class: "space-y-10",
            header {
                h1 { class: "font-display text-4xl tracking-wide text-fg sm:text-6xl",
                    "trinkhallen"
                    span { class: "text-neon-pink", "." }
                    "app"
                }
                p { class: "mt-3 text-lg text-fg-muted",
                    "{total_label} Trinkhallen, Wasserhäuschen und Spätis in einer Karte. Offen, durchsuchbar, von der Community gepflegt — nicht-kommerziell."
                }
            }

            section { class: "grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3", dangerous_inner_html: "{metrics}" }

            section {
                h2 { class: "font-display text-2xl tracking-wide text-fg", "▶▶▶ Was ist das?" }
                p { class: "mt-3 text-fg-muted",
                    "Du suchst einen Späti mit Kartenzahlung, der gerade offen hat, und willst direkt hin navigieren? Genau dafür ist trinkhallen.app gebaut."
                }
                p { class: "mt-3 text-fg-muted",
                    "trinkhallen.app ist der offene Nachfolger von "
                    a { class: "text-neon-cyan underline underline-offset-2", href: "https://app.hopfenstop.de/", "HopfenStop" }
                    ". Der sorgfältig kuratierte Frankfurter Datensatz von HopfenStop bildet die Basis und lebt hier weiter — ergänzt um OpenStreetMap-Daten für ganz Deutschland, eine transparente Beitrags-Pipeline auf GitHub und Pflege durch die Community statt durch eine einzelne Person."
                }
            }

            section {
                h2 { class: "font-display text-2xl tracking-wide text-fg", "▶▶▶ Daten" }
                p { class: "mt-3 text-fg-muted",
                    "Alle Kiosk-Metadaten liegen offen auf GitHub als GeoJSON, mit pro-Eintrag Quellenangabe ("
                    code { class: "font-mono", "sources[]" }
                    "):"
                }
                ul { class: "mt-3 space-y-2 text-fg-muted",
                    li {
                        a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland/trinkhallen-data", "boredland/trinkhallen-data" }
                        " — der Datensatz. PRs willkommen."
                    }
                    li {
                        a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland/trinkhallen-app", "boredland/trinkhallen-app" }
                        " — Code (Cloudflare Workers + Rust/Dioxus)."
                    }
                }
                p { class: "mt-3 text-sm text-fg-dim",
                    strong { "Quellen:" }
                    " HopfenStop (Frankfurt-Seed, "
                    a { class: "text-neon-cyan underline underline-offset-2", href: "https://creativecommons.org/licenses/by-nc/4.0/", "CC BY-NC 4.0" }
                    " ) · OpenStreetMap ("
                    a { class: "text-neon-cyan underline underline-offset-2", href: "https://www.openstreetmap.org/copyright", "ODbL" }
                    " ) · Beiträge der Nutzer:innen."
                }
            }

            section {
                h2 { class: "font-display text-2xl tracking-wide text-fg", "▶▶▶ Mitmachen" }
                ul { class: "mt-3 space-y-3 text-fg-muted",
                    li {
                        span { class: "font-display text-fg", "Bewerten:" }
                        " 1–5 Sterne + optionaler Kommentar auf jeder Detailseite (Login nötig)."
                    }
                    li {
                        span { class: "font-display text-fg", "Warst du hier?" }
                        " Auf der Detailseite mit einem Tap einchecken — wenn Daten fehlen (Öffnungszeiten, Zahlung, Sitzen, WC, …), fragt das Formular kurz nach. Antworten gehen durch Moderation und landen im offenen Datensatz."
                    }
                    li {
                        span { class: "font-display text-fg", "Korrigieren:" }
                        " „Daten falsch?\"-Bereich deckt geschlossen, doppelter Eintrag, falsche Adresse usw. ab. Moderation prüft und übernimmt die Korrektur in den Datensatz."
                    }
                    li {
                        span { class: "font-display text-fg", "Vorschlagen:" }
                        " "
                        a { class: "text-neon-cyan underline underline-offset-2", href: "{add_href}", "/add" }
                        " → Späti auf der Karte anklicken, Adresse + Öffnungszeiten + Zahlung eintragen."
                    }
                    li {
                        span { class: "font-display text-fg", "Direkt PR auf GitHub:" }
                        " Wer mag, kann den Datensatz auch direkt forken und PRs gegen "
                        a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland/trinkhallen-data", "trinkhallen-data" }
                        " öffnen — der Datensatz ist primary, die App nur die UI obendrauf."
                    }
                }
            }

            section {
                h2 { class: "font-display text-2xl tracking-wide text-fg", "▶▶▶ Stack" }
                ul { class: "mt-3 space-y-1.5 text-sm text-fg-muted",
                    li { "Cloudflare Workers · Rust · Dioxus (SSR + Islands) · D1 (SQLite)" }
                    li { "MapLibre GL JS · OpenFreeMap (Vektor-Tiles, ohne API-Key)" }
                    li { "Tailwind CSS v4 · Anton / Inter · keine Tracker, kein Analytics" }
                    li { "Auth: Magic-Link per Mail (Cloudflare Email Routing) oder Google SSO — mit automatischem Merge der beiden bei gleicher Adresse." }
                    li { "Wöchentliches OSM-Ingest + Daten-Anreicherung (Öffnungszeiten, Zahlung, Place-IDs) per GitHub Actions Pipeline." }
                }
            }

            section {
                h2 { class: "font-display text-2xl tracking-wide text-fg", "▶▶▶ Lizenz" }
                p { class: "mt-3 text-sm text-fg-muted",
                    strong { class: "text-fg", "Daten:" }
                    " CC BY-NC 4.0 — frei zum Teilen und Anpassen, mit Attribution, nicht-kommerziell."
                    br {}
                    strong { class: "text-fg", "Code:" }
                    " AGPL-3.0-or-later."
                }
            }

            section {
                h2 { class: "font-display text-2xl tracking-wide text-fg", "▶▶▶ Betreiber" }
                p { class: "mt-3 text-fg-muted",
                    "trinkhallen.app wird von "
                    a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland", "Jonas (boredland)" }
                    " als nicht-kommerzielles Open-Source-Projekt betrieben. Kontakt & Issues über "
                    a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland/trinkhallen-app/issues", "GitHub" }
                    "."
                }
            }

            footer { class: "pt-4 text-xs text-fg-dim",
                "Bugs & Wünsche → "
                a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland/trinkhallen-app/issues", "GitHub Issues" }
                "."
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn german_body_is_the_inline_pages_body() {
        let (body, meta) = render(&AboutData {
            lang: Lang::De,
            total: 1234,
            ratings: 56,
            users: 7,
        });
        assert!(
            body.contains("1.234 Trinkhallen, Wasserhäuschen und Spätis in einer Karte."),
            "{body}"
        );
        assert!(body.contains("▶▶▶ Was ist das?"), "{body}");
        assert!(body.contains("▶▶▶ Daten"), "{body}");
        assert!(body.contains("▶▶▶ Mitmachen"), "{body}");
        assert!(body.contains("▶▶▶ Stack"), "{body}");
        assert!(body.contains("▶▶▶ Lizenz"), "{body}");
        assert!(body.contains("▶▶▶ Betreiber"), "{body}");
        assert!(body.contains("<div class=\"font-display text-5xl text-neon-pink tabular-nums sm:text-6xl\">1.234</div>"), "{body}");
        assert!(body.contains("href=\"/add\">/add</a>"), "{body}");
        assert_eq!(meta.title.as_deref(), Some("Über trinkhallen.app"));
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/about")
        );
    }

    #[test]
    fn english_body_is_the_courtesy_translation() {
        let (body, meta) = render(&AboutData {
            lang: Lang::En,
            total: 1234,
            ratings: 56,
            users: 7,
        });
        assert!(
            body.contains("1,234 Trinkhallen, Wasserhäuschen and Spätis on one map."),
            "{body}"
        );
        assert!(body.contains("▶▶▶ What is this?"), "{body}");
        assert!(body.contains("▶▶▶ Get involved"), "{body}");
        assert!(body.contains("▶▶▶ Licence"), "{body}");
        assert!(body.contains("▶▶▶ Operator"), "{body}");
        assert!(body.contains("Trinkhallen mapped"), "{body}");
        assert_eq!(meta.title.as_deref(), Some("About trinkhallen.app"));
    }
}
