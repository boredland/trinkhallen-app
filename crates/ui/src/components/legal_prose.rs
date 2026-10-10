//! `LegalProse.tsx`: the English prose bodies of the otherwise-German static
//! pages (`/about`, `/impressum`, `/datenschutz`). The German versions live in
//! `pages::about` / `pages::legal` and stay authoritative; these are courtesy
//! translations rendered for the `en` locale. Domain nouns (Trinkhalle/Späti/
//! Wasserhäuschen) stay untranslated — they are the app's proper nouns.

use dioxus::prelude::*;
use trinkhallen_core::i18n::{Lang, path_for_lang};

use crate::components::shared::format_locale;
use crate::render::to_html;

const A: &str = "text-neon-cyan underline underline-offset-2";
const H2: &str = "font-display text-2xl tracking-wide text-fg";
const H2_SM: &str = "font-display text-xl tracking-wide text-fg";

/// Banner atop the legally-relevant pages, pointing at the binding German
/// original (the default locale, so a plain root-relative link).
fn courtesy_note(german_href: &str) -> Element {
    rsx! {
        p { class: "border-2 border-border bg-surface-2 p-3 text-sm text-fg-muted",
            "This is a courtesy translation. The "
            a { class: "{A}", href: "{german_href}", "German version" }
            " is the legally binding one."
        }
    }
}

fn metric(value: u64, label: &str, lang: Lang) -> Element {
    let value = format_locale(value, lang);
    rsx! {
        div { class: "border-2 border-border bg-surface p-4 sm:p-6",
            div { class: "font-display text-3xl text-neon-pink sm:text-5xl", "{value}" }
            div { class: "mt-1 text-sm text-fg-muted", "{label}" }
        }
    }
}

pub fn about_en(total: u64, ratings: u64, users: u64) -> String {
    let lang = Lang::En;
    let total_label = format_locale(total, lang);
    let add_href = path_for_lang("/add", lang);
    to_html(rsx! {
        article { class: "space-y-10",
            header {
                h1 { class: "font-display text-4xl tracking-wide text-fg sm:text-6xl",
                    "trinkhallen"
                    span { class: "text-neon-pink", "." }
                    "app"
                }
                p { class: "mt-3 text-lg text-fg-muted",
                    "{total_label} Trinkhallen, Wasserhäuschen and Spätis on one map. Open, searchable, community-maintained — non-commercial."
                }
            }

            section { class: "grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3",
                {metric(total, "Trinkhallen mapped", lang)}
                {metric(ratings, "Ratings submitted", lang)}
                {metric(users, "Registered people", lang)}
            }

            section {
                h2 { class: "{H2}", "▶▶▶ What is this?" }
                p { class: "mt-3 text-fg-muted",
                    "Looking for a Späti with card payment that's open right now, and want to navigate straight there? That's exactly what trinkhallen.app is built for."
                }
                p { class: "mt-3 text-fg-muted",
                    "trinkhallen.app is the open successor to "
                    a { class: "{A}", href: "https://app.hopfenstop.de/", "HopfenStop" }
                    ". HopfenStop's carefully curated Frankfurt dataset forms the basis and lives on here — supplemented with OpenStreetMap data for the whole of Germany, a transparent contribution pipeline on GitHub, and maintenance by the community rather than a single person."
                }
            }

            section {
                h2 { class: "{H2}", "▶▶▶ Data" }
                p { class: "mt-3 text-fg-muted",
                    "All kiosk metadata is openly available on GitHub as GeoJSON, with per-entry source attribution ("
                    code { class: "font-mono", "sources[]" }
                    "):"
                }
                ul { class: "mt-3 space-y-2 text-fg-muted",
                    li {
                        a { class: "{A}", href: "https://github.com/boredland/trinkhallen-data", "boredland/trinkhallen-data" }
                        " — the dataset. PRs welcome."
                    }
                    li {
                        a { class: "{A}", href: "https://github.com/boredland/trinkhallen-app", "boredland/trinkhallen-app" }
                        " — the code (Cloudflare Workers + Hono)."
                    }
                }
                p { class: "mt-3 text-sm text-fg-dim",
                    strong { "Sources:" }
                    " HopfenStop (Frankfurt seed, "
                    a { class: "{A}", href: "https://creativecommons.org/licenses/by-nc/4.0/", "CC BY-NC 4.0" }
                    " ) · OpenStreetMap ("
                    a { class: "{A}", href: "https://www.openstreetmap.org/copyright", "ODbL" }
                    " ) · contributions from users."
                }
            }

            section {
                h2 { class: "{H2}", "▶▶▶ Get involved" }
                ul { class: "mt-3 space-y-3 text-fg-muted",
                    li {
                        span { class: "font-display text-fg", "Rate:" }
                        " 1–5 stars + an optional comment on every detail page (login required)."
                    }
                    li {
                        span { class: "font-display text-fg", "Were you here?" }
                        " Check in with a single tap on the detail page — if data is missing (opening hours, payment, seating, toilet, …) the form asks a quick question. Answers go through moderation and land in the open dataset."
                    }
                    li {
                        span { class: "font-display text-fg", "Correct:" }
                        " the “Data wrong?” section covers closed, duplicate entry, wrong address and so on. Moderation reviews it and folds the correction into the dataset."
                    }
                    li {
                        span { class: "font-display text-fg", "Suggest:" }
                        " "
                        a { class: "{A}", href: "{add_href}", "/add" }
                        " → click a Späti on the map, enter address + opening hours + payment."
                    }
                    li {
                        span { class: "font-display text-fg", "PR directly on GitHub:" }
                        " if you prefer, fork the dataset and open PRs against "
                        a { class: "{A}", href: "https://github.com/boredland/trinkhallen-data", "trinkhallen-data" }
                        " — the dataset is primary, the app is just the UI on top."
                    }
                }
            }

            section {
                h2 { class: "{H2}", "▶▶▶ Stack" }
                ul { class: "mt-3 space-y-1.5 text-sm text-fg-muted",
                    li { "Cloudflare Workers · Hono SSR · TypeScript · D1 (SQLite)" }
                    li { "MapLibre GL JS · OpenFreeMap (vector tiles, no API key)" }
                    li { "Tailwind CSS v4 · Anton / Inter · no trackers, no analytics" }
                    li { "Auth: magic link by email (Cloudflare Email Routing) or Google SSO — with automatic merge of the two when the address matches." }
                    li { "Weekly OSM ingest + data enrichment (opening hours, payment, place IDs) via a GitHub Actions pipeline." }
                }
            }

            section {
                h2 { class: "{H2}", "▶▶▶ Licence" }
                p { class: "mt-3 text-sm text-fg-muted",
                    strong { class: "text-fg", "Data:" }
                    " CC BY-NC 4.0 — free to share and adapt, with attribution, non-commercial."
                    br {}
                    strong { class: "text-fg", "Code:" }
                    " AGPL-3.0-or-later."
                }
            }

            section {
                h2 { class: "{H2}", "▶▶▶ Operator" }
                p { class: "mt-3 text-fg-muted",
                    "trinkhallen.app is run by "
                    a { class: "{A}", href: "https://github.com/boredland", "Jonas (boredland)" }
                    " as a non-commercial open-source project. Contact & issues via "
                    a { class: "{A}", href: "https://github.com/boredland/trinkhallen-app/issues", "GitHub" }
                    "."
                }
            }

            footer { class: "pt-4 text-xs text-fg-dim",
                "Bugs & wishes → "
                a { class: "{A}", href: "https://github.com/boredland/trinkhallen-app/issues", "GitHub Issues" }
                "."
            }
        }
    })
}

pub fn impressum_en() -> String {
    to_html(rsx! {
        article { class: "space-y-8",
            header {
                h1 { class: "font-display text-4xl tracking-wide text-fg sm:text-5xl", "Legal notice" }
                p { class: "mt-3 text-fg-muted", "Information pursuant to § 5 TMG" }
            }
            {courtesy_note("/impressum")}

            section {
                h2 { class: "{H2_SM}", "Operator" }
                address { class: "mt-3 not-italic text-fg-muted",
                    "Jonas Strassel"
                    br {}
                    "Am Kappelgarten 24"
                    br {}
                    "60389 Frankfurt am Main"
                    br {}
                    "Germany"
                }
            }

            section {
                h2 { class: "{H2_SM}", "Contact" }
                p { class: "mt-3 text-fg-muted",
                    "Email: "
                    a { class: "{A}", href: "mailto:feedback@trinkhallen.app", "feedback@trinkhallen.app" }
                }
            }

            section {
                h2 { class: "{H2_SM}", "Responsible for the content" }
                p { class: "mt-3 text-fg-muted",
                    "Jonas Strassel (address as above). trinkhallen.app is a non-commercial open-source project; the dataset lives in a public "
                    a { class: "{A}", href: "https://github.com/boredland/trinkhallen-data", "GitHub repository" }
                    " and is maintained by the community."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Liability for content" }
                p { class: "mt-3 text-fg-muted",
                    "The contents of this site were created with the greatest possible care. However, no guarantee can be given for the accuracy, completeness and timeliness of the kiosk data (opening hours, payment methods, location, etc.) — it comes from open sources (OpenStreetMap, community contributions) and may be out of date."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Liability for links" }
                p { class: "mt-3 text-fg-muted",
                    "This site contains links to external third-party websites over whose content we have no influence. The respective provider is always responsible for that third-party content. If we become aware of any legal infringements, the relevant links will be removed promptly."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Copyright" }
                p { class: "mt-3 text-fg-muted",
                    "The source code of this application is licensed under "
                    a { class: "{A}", href: "https://www.gnu.org/licenses/agpl-3.0.html", "AGPL-3.0-or-later" }
                    ", the dataset under "
                    a { class: "{A}", href: "https://creativecommons.org/licenses/by-nc/4.0/", "CC BY-NC 4.0" }
                    ". Map data © OpenStreetMap contributors ("
                    a { class: "{A}", href: "https://www.openstreetmap.org/copyright", "ODbL" }
                    ")."
                }
            }
        }
    })
}

pub fn datenschutz_en() -> String {
    to_html(rsx! {
        article { class: "space-y-8",
            header {
                h1 { class: "font-display text-4xl tracking-wide text-fg sm:text-5xl", "Privacy policy" }
                p { class: "mt-3 text-fg-muted",
                    "We store as little as possible. No trackers, no analytics, no advertising. What we process and why is set out in full here."
                }
            }
            {courtesy_note("/datenschutz")}

            section {
                h2 { class: "{H2_SM}", "Controller" }
                address { class: "mt-3 not-italic text-fg-muted",
                    "Jonas Strassel"
                    br {}
                    "Am Kappelgarten 24"
                    br {}
                    "60389 Frankfurt am Main"
                    br {}
                    "Email: "
                    a { class: "{A}", href: "mailto:feedback@trinkhallen.app", "feedback@trinkhallen.app" }
                }
            }

            section {
                h2 { class: "{H2_SM}", "Anonymous use of the map" }
                p { class: "mt-3 text-fg-muted",
                    "You can use the map completely anonymously — no account, no login. When the page is loaded, technically unavoidable data (IP address, user agent, requested URL) is logged in the server logs of our host, Cloudflare. Legal basis: Art. 6(1)(f) GDPR (legitimate interest in the operation and security of the site). Storage period: a maximum of 30 days."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Login by email (magic link)" }
                p { class: "mt-3 text-fg-muted",
                    "When you log in by magic link, we store your email address, a hashed version of the one-time token, and your IP address and user agent (for abuse protection). The token becomes invalid once redeemed, or after 15 minutes at the latest. Legal basis: Art. 6(1)(b) GDPR (performance of the usage relationship)."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Login via Google" }
                p { class: "mt-3 text-fg-muted",
                    "If you log in via Google, we store only your email address and a stable internal ID from your Google profile. We store neither your name nor your profile picture — should Google transmit them, we discard them. When you are redirected to Google, your browser shares your IP address with Google. We process the data solely to recognise you and attribute your content (ratings, corrections, check-ins) to you. Legal basis: Art. 6(1)(b) GDPR; data is only transmitted to Google if you actively start the login."
                }
                p { class: "mt-3 text-fg-muted",
                    "Provider: Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland. Privacy: "
                    a { class: "{A}", href: "https://policies.google.com/privacy", "policies.google.com/privacy" }
                    "."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Login via Apple" }
                p { class: "mt-3 text-fg-muted",
                    "If you log in via “Sign in with Apple”, we receive your email address and a stable internal ID from Apple. If you choose Apple's “Hide My Email”, that is an anonymous relay address — we can only reach you by email through it, without knowing your real address. We don't ask for a name, and Apple doesn't provide a profile picture. We process the data solely to recognise you and attribute your content to you. Legal basis: Art. 6(1)(b) GDPR; data is only transmitted to Apple if you actively start the login."
                }
                p { class: "mt-3 text-fg-muted",
                    "Provider: Apple Distribution International Ltd., Hollyhill Industrial Estate, Hollyhill, Cork, Ireland. Privacy: "
                    a { class: "{A}", href: "https://www.apple.com/legal/privacy/", "apple.com/legal/privacy" }
                    "."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Session cookie" }
                p { class: "mt-3 text-fg-muted",
                    "When you're logged in, we set a single session cookie ("
                    code { class: "font-mono", "__Host-tk_sess" }
                    ") containing a random, cryptographically signed ID. It is "
                    code { class: "font-mono", "HttpOnly" }
                    ", "
                    code { class: "font-mono", "Secure" }
                    " and expires after 30 days of inactivity. We use no tracking or marketing cookies. Legal basis: Art. 6(1)(b) GDPR (technically necessary for operation)."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Your own contributions" }
                p { class: "mt-3 text-fg-muted",
                    "Ratings, data corrections, Späti suggestions and check-ins are stored linked to your user account. Approved corrections and suggestions are additionally folded into the public, openly licensed dataset "
                    a { class: "{A}", href: "https://github.com/boredland/trinkhallen-data", "trinkhallen-data" }
                    " and become a permanent part of the open history there. A random UUID with no personal reference for outsiders is stored with the entry. The only thing publicly visible next to your ratings is your automatically generated, pseudonymous handle (e.g. @pfand_pirat) — never your name. Legal basis: Art. 6(1)(b) GDPR."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Third parties & data transfers" }
                ul { class: "mt-3 space-y-3 text-fg-muted",
                    li {
                        strong { class: "text-fg", "Cloudflare" }
                        " (Workers, D1 database, edge cache): hosting of the application. Location: worldwide. A data processing agreement (DPA) and standard contractual clauses are in place."
                    }
                    li {
                        strong { class: "text-fg", "Google" }
                        ": only if you use the Google login (see above)."
                    }
                    li {
                        strong { class: "text-fg", "OpenFreeMap" }
                        ": provides the map tiles. When the map is displayed, your browser shares your IP address with OpenFreeMap to deliver the tiles. Provider: "
                        a { class: "{A}", href: "https://openfreemap.org/", "openfreemap.org" }
                        "."
                    }
                    li {
                        strong { class: "text-fg", "Photon (Komoot)" }
                        ": pre-fills the address on "
                        code { "/add" }
                        " from your chosen map position. Your browser sends the coordinates to Photon (based on OpenStreetMap data); the IP address is technically unavoidable. Provider: Komoot GmbH; "
                        a { class: "{A}", href: "https://photon.komoot.io/", "photon.komoot.io" }
                        "."
                    }
                }
            }

            section {
                h2 { class: "{H2_SM}", "Storage period" }
                p { class: "mt-3 text-fg-muted",
                    "Account and contribution data remain stored as long as your account exists. Delete your account by sending a short email to the address above — we delete it within 14 days. Server logs are automatically discarded after a maximum of 30 days. Magic-link tokens are invalid once redeemed or after 15 minutes."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Your rights" }
                p { class: "mt-3 text-fg-muted",
                    "You have the right at any time to access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction of processing (Art. 18), data portability (Art. 20) and objection (Art. 21). A short email to "
                    a { class: "{A}", href: "mailto:feedback@trinkhallen.app", "feedback@trinkhallen.app" }
                    " is enough."
                }
                p { class: "mt-3 text-fg-muted",
                    "You also have the right to lodge a complaint with a data protection supervisory authority — the one responsible for us: "
                    a { class: "{A}", href: "https://datenschutz.hessen.de/", "The Hessian Commissioner for Data Protection and Freedom of Information" }
                    "."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Android app (Trusted Web Activity)" }
                p { class: "mt-3 text-fg-muted",
                    "The Android app on the Google Play Store ("
                    code { class: "font-mono", "app.trinkhallen.twa" }
                    " ) is a "
                    em { "Trusted Web Activity" }
                    " — technically, it loads only this website in a full-screen Chrome browser container. There is no separate app data path, no additional trackers, and no processing beyond the data flows described above. All the rules stated here on logging, login, cookies and contributions apply identically to the app."
                }
                p { class: "mt-3 text-fg-muted",
                    "Independently of this, Google Play collects technical telemetry when the app is installed, updated or uninstalled (device and Android version, country, optional crash reports). We have no direct access to this data; it is subject to the "
                    a { class: "{A}", href: "https://policies.google.com/privacy", "Google privacy policy" }
                    ". Push notifications are currently not enabled."
                }
            }

            section {
                h2 { class: "{H2_SM}", "Changes" }
                p { class: "mt-3 text-fg-muted",
                    "This statement may change as we develop the service further. The current version is always shown here. We will announce material changes before they take effect."
                }
            }
        }
    })
}
