//! `/impressum` and `/datenschutz` (`pages.tsx` + `LegalProse.tsx` English
//! bodies). German is the binding version; English is a courtesy translation.

use dioxus::prelude::*;
use trinkhallen_core::ORIGIN;
use trinkhallen_core::i18n::{Lang, t};

use crate::components::legal_prose;
use crate::model::Nav;
use crate::pages::PageMeta;
use crate::render::{ClientEntry, to_html};

pub fn impressum(lang: Lang) -> (String, PageMeta) {
    let body = if lang == Lang::En {
        legal_prose::impressum_en()
    } else {
        impressum_de()
    };
    (body, meta(lang, "impressum"))
}

pub fn datenschutz(lang: Lang) -> (String, PageMeta) {
    let body = if lang == Lang::En {
        legal_prose::datenschutz_en()
    } else {
        datenschutz_de()
    };
    (body, meta(lang, "datenschutz"))
}

fn meta(lang: Lang, slug: &str) -> PageMeta {
    let key = if slug == "impressum" {
        "page.impressum"
    } else {
        "page.datenschutz"
    };
    PageMeta {
        title: Some(t(lang, &format!("{key}.title"))),
        description: Some(t(lang, &format!("{key}.description"))),
        canonical_url: Some(format!("{ORIGIN}/{slug}")),
        entries: vec![ClientEntry::App],
        nav: Some(Nav::About),
        ..Default::default()
    }
}

const A: &str = "text-neon-cyan underline underline-offset-2";
const H2: &str = "font-display text-xl tracking-wide text-fg";

fn impressum_de() -> String {
    to_html(rsx! {
        article { class: "space-y-8",
            header {
                h1 { class: "font-display text-4xl tracking-wide text-fg sm:text-5xl", "Impressum" }
                p { class: "mt-3 text-fg-muted", "Angaben gemäß § 5 TMG" }
            }

            section {
                h2 { class: "{H2}", "Betreiber" }
                address { class: "mt-3 not-italic text-fg-muted",
                    "Jonas Strassel"
                    br {}
                    "Am Kappelgarten 24"
                    br {}
                    "60389 Frankfurt am Main"
                    br {}
                    "Deutschland"
                }
            }

            section {
                h2 { class: "{H2}", "Kontakt" }
                p { class: "mt-3 text-fg-muted",
                    "E-Mail: "
                    a { class: "{A}", href: "mailto:feedback@trinkhallen.app", "feedback@trinkhallen.app" }
                }
            }

            section {
                h2 { class: "{H2}", "Verantwortlich für den Inhalt" }
                p { class: "mt-3 text-fg-muted",
                    "Jonas Strassel (Anschrift wie oben). trinkhallen.app ist ein nicht-kommerzielles Open-Source-Projekt; der Datensatz lebt in einem öffentlichen "
                    a { class: "{A}", href: "https://github.com/boredland/trinkhallen-data", "GitHub-Repository" }
                    " und wird von der Community gepflegt."
                }
            }

            section {
                h2 { class: "{H2}", "Haftung für Inhalte" }
                p { class: "mt-3 text-fg-muted",
                    "Die Inhalte dieser Seite wurden mit größtmöglicher Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität der Kiosk-Daten (Öffnungszeiten, Zahlungsmethoden, Standort etc.) kann jedoch keine Gewähr übernommen werden — sie stammen aus offenen Quellen (OpenStreetMap, Community-Beiträge) und können veraltet sein."
                }
            }

            section {
                h2 { class: "{H2}", "Haftung für Links" }
                p { class: "mt-3 text-fg-muted",
                    "Diese Seite enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Für diese fremden Inhalte ist stets der jeweilige Anbieter verantwortlich. Bei Bekanntwerden von Rechtsverletzungen werden entsprechende Links umgehend entfernt."
                }
            }

            section {
                h2 { class: "{H2}", "Urheberrecht" }
                p { class: "mt-3 text-fg-muted",
                    "Der Quellcode dieser Anwendung steht unter "
                    a { class: "{A}", href: "https://www.gnu.org/licenses/agpl-3.0.de.html", "AGPL-3.0-or-later" }
                    ", der Datensatz unter "
                    a { class: "{A}", href: "https://creativecommons.org/licenses/by-nc/4.0/deed.de", "CC BY-NC 4.0" }
                    ". Kartendaten © OpenStreetMap-Mitwirkende ("
                    a { class: "{A}", href: "https://www.openstreetmap.org/copyright", "ODbL" }
                    ")."
                }
            }
        }
    })
}

fn datenschutz_de() -> String {
    to_html(rsx! {
        article { class: "space-y-8",
            header {
                h1 { class: "font-display text-4xl tracking-wide text-fg sm:text-5xl", "Datenschutzerklärung" }
                p { class: "mt-3 text-fg-muted",
                    "Wir speichern so wenig wie möglich. Keine Tracker, kein Analytics, keine Werbung. Was wir verarbeiten und warum, steht hier vollständig."
                }
            }

            section {
                h2 { class: "{H2}", "Verantwortlicher" }
                address { class: "mt-3 not-italic text-fg-muted",
                    "Jonas Strassel"
                    br {}
                    "Am Kappelgarten 24"
                    br {}
                    "60389 Frankfurt am Main"
                    br {}
                    "E-Mail: "
                    a { class: "{A}", href: "mailto:feedback@trinkhallen.app", "feedback@trinkhallen.app" }
                }
            }

            section {
                h2 { class: "{H2}", "Anonyme Nutzung der Karte" }
                p { class: "mt-3 text-fg-muted",
                    "Du kannst die Karte vollständig anonym benutzen — ohne Konto, ohne Login. Beim Aufruf der Seite werden technisch unvermeidbare Daten (IP-Adresse, User-Agent, angeforderte URL) in den Server-Logs unseres Hosters Cloudflare protokolliert. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Betrieb und Sicherheit der Seite). Speicherdauer: maximal 30 Tage."
                }
            }

            section {
                h2 { class: "{H2}", "Login per E-Mail (Magic Link)" }
                p { class: "mt-3 text-fg-muted",
                    "Wenn du dich per Magic-Link anmeldest, speichern wir deine E-Mail-Adresse, eine gehashte Version des Einmal-Tokens sowie IP-Adresse und User-Agent (für Missbrauchsschutz). Der Token wird nach Einlösung oder spätestens 15 Minuten ungültig. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Durchführung des Nutzungsverhältnisses)."
                }
            }

            section {
                h2 { class: "{H2}", "Login per Google" }
                p { class: "mt-3 text-fg-muted",
                    "Wenn du dich per Google anmeldest, speichern wir von deinem Google-Profil nur deine E-Mail-Adresse und eine stabile interne ID. Weder deinen Namen noch dein Profilbild speichern wir — sollte Google sie mit übermitteln, verwerfen wir sie. Bei der Weiterleitung zu Google teilt dein Browser deine IP-Adresse mit Google. Wir verarbeiten die Daten ausschließlich, um dich wiederzuerkennen und dir deine Inhalte (Bewertungen, Korrekturen, Check-ins) zuzuordnen. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO; die Datenübermittlung an Google erfolgt nur, wenn du den Login aktiv anstößt."
                }
                p { class: "mt-3 text-fg-muted",
                    "Anbieter: Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland. Datenschutz: "
                    a { class: "{A}", href: "https://policies.google.com/privacy", "policies.google.com/privacy" }
                    "."
                }
            }

            section {
                h2 { class: "{H2}", "Login per Apple" }
                p { class: "mt-3 text-fg-muted",
                    "Wenn du dich per „Mit Apple anmelden\" einloggst, erhalten wir von Apple deine E-Mail-Adresse und eine stabile interne ID. Wählst du Apples „E-Mail verbergen\", ist das eine anonyme Relay-Adresse — wir erreichen dich darüber nur per Mail, ohne deine echte Adresse zu kennen. Einen Namen fragen wir nicht ab, ein Profilbild liefert Apple nicht. Wir verarbeiten die Daten ausschließlich, um dich wiederzuerkennen und dir deine Inhalte zuzuordnen. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO; die Datenübermittlung an Apple erfolgt nur, wenn du den Login aktiv anstößt."
                }
                p { class: "mt-3 text-fg-muted",
                    "Anbieter: Apple Distribution International Ltd., Hollyhill Industrial Estate, Hollyhill, Cork, Irland. Datenschutz: "
                    a { class: "{A}", href: "https://www.apple.com/legal/privacy/", "apple.com/legal/privacy" }
                    "."
                }
            }

            section {
                h2 { class: "{H2}", "Sitzungs-Cookie" }
                p { class: "mt-3 text-fg-muted",
                    "Bist du eingeloggt, setzen wir ein einziges Sitzungs-Cookie ("
                    code { class: "font-mono", "__Host-tk_sess" }
                    "), das eine zufällige, kryptographisch signierte ID enthält. Es ist "
                    code { class: "font-mono", " HttpOnly" }
                    ", "
                    code { class: "font-mono", "Secure" }
                    " und läuft nach 30 Tagen ohne Aktivität ab. Wir verwenden keine Tracking- oder Marketing-Cookies. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (für den Betrieb technisch notwendig)."
                }
            }

            section {
                h2 { class: "{H2}", "Eigene Beiträge" }
                p { class: "mt-3 text-fg-muted",
                    "Bewertungen, Daten-Korrekturen, Späti-Vorschläge und Check-ins werden mit deinem Nutzerkonto verknüpft gespeichert. Freigegebene Korrekturen und Vorschläge werden außerdem in den öffentlichen, offen lizenzierten Datensatz "
                    a { class: "{A}", href: "https://github.com/boredland/trinkhallen-data", "trinkhallen-data" }
                    " übernommen und sind dort dauerhaft Teil der offenen Geschichte. Mit dem Eintrag gespeichert wird eine zufällige UUID ohne Personenbezug für Außenstehende. Öffentlich neben deinen Bewertungen sichtbar ist nur dein automatisch erzeugter, pseudonymer Handle (z. B. @pfand_pirat) — niemals dein Name. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO."
                }
            }

            section {
                h2 { class: "{H2}", "Drittanbieter & Datenübermittlung" }
                ul { class: "mt-3 space-y-3 text-fg-muted",
                    li {
                        strong { class: "text-fg", "Cloudflare" }
                        " (Workers, D1-Datenbank, Edge-Cache): Hosting der Anwendung. Standort: weltweit. Auftragsverarbeitungsvertrag (DPA) und Standardvertragsklauseln liegen vor."
                    }
                    li {
                        strong { class: "text-fg", "Google" }
                        ": nur wenn du den Google-Login nutzt (siehe oben)."
                    }
                    li {
                        strong { class: "text-fg", "OpenFreeMap" }
                        ": liefert die Kartenkacheln. Beim Anzeigen der Karte teilt dein Browser deine IP-Adresse mit OpenFreeMap, um die Kacheln auszuliefern. Anbieter: "
                        a { class: "{A}", href: "https://openfreemap.org/", "openfreemap.org" }
                        "."
                    }
                    li {
                        strong { class: "text-fg", "Photon (Komoot)" }
                        ": füllt auf "
                        code { "/add" }
                        " die Adresse aus deiner gewählten Kartenposition vor. Dein Browser sendet die Koordinaten an Photon (basiert auf OpenStreetMap-Daten), die IP-Adresse ist technisch unvermeidbar. Anbieter: Komoot GmbH; "
                        a { class: "{A}", href: "https://photon.komoot.io/", "photon.komoot.io" }
                        "."
                    }
                }
            }

            section {
                h2 { class: "{H2}", "Speicherdauer" }
                p { class: "mt-3 text-fg-muted",
                    "Konto- und Beitragsdaten bleiben gespeichert, solange dein Konto besteht. Lösche dein Konto, indem du eine kurze Mail an die oben genannte Adresse schickst — wir löschen es innerhalb von 14 Tagen. Server-Logs werden nach maximal 30 Tagen automatisch verworfen. Magic-Link-Token sind nach Einlösung oder 15 Minuten ungültig."
                }
            }

            section {
                h2 { class: "{H2}", "Deine Rechte" }
                p { class: "mt-3 text-fg-muted",
                    "Du hast jederzeit das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21). Eine kurze Mail an "
                    a { class: "{A}", href: "mailto:feedback@trinkhallen.app", "feedback@trinkhallen.app" }
                    " reicht."
                }
                p { class: "mt-3 text-fg-muted",
                    "Außerdem hast du das Recht, dich bei einer Datenschutz-Aufsichtsbehörde zu beschweren — für uns zuständig: "
                    a { class: "{A}", href: "https://datenschutz.hessen.de/", "Der Hessische Beauftragte für Datenschutz und Informationsfreiheit" }
                    "."
                }
            }

            section {
                h2 { class: "{H2}", "Android-App (Trusted Web Activity)" }
                p { class: "mt-3 text-fg-muted",
                    "Die Android-App im Google Play Store ("
                    code { class: "font-mono", "app.trinkhallen.twa" }
                    ") ist eine "
                    em { "Trusted Web Activity" }
                    " — technisch lädt sie ausschließlich diese Website in einem Vollbild-Browser-Container von Chrome. Es gibt keinen separaten App-Datenpfad, keine zusätzlichen Tracker und keine über die oben beschriebenen Datenflüsse hinausgehende Verarbeitung. Alle hier genannten Regeln zu Logging, Login, Cookies und Beiträgen gelten für die App identisch."
                }
                p { class: "mt-3 text-fg-muted",
                    "Unabhängig davon erhebt Google Play beim Installieren, Aktualisieren oder Deinstallieren der App technische Telemetrie (Geräte- und Android-Version, Land, optionale Absturzberichte). Auf diese Daten haben wir keinen direkten Zugriff; sie unterliegen den "
                    a { class: "{A}", href: "https://policies.google.com/privacy", "Google-Datenschutzbestimmungen" }
                    ". Push-Benachrichtigungen sind aktuell nicht aktiviert."
                }
            }

            section {
                h2 { class: "{H2}", "Änderungen" }
                p { class: "mt-3 text-fg-muted",
                    "Diese Erklärung kann sich ändern, wenn wir das Angebot weiterentwickeln. Der jeweils aktuelle Stand steht hier. Wesentliche Änderungen kündigen wir vor Inkrafttreten an."
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impressum_english_is_the_legalprose_body() {
        let (body, meta) = impressum(Lang::En);
        assert!(body.contains("<h1 class=\"font-display text-4xl tracking-wide text-fg sm:text-5xl\">Legal notice</h1>"), "{body}");
        assert!(body.contains("Information pursuant to § 5 TMG"), "{body}");
        assert!(body.contains("This is a courtesy translation."), "{body}");
        assert!(
            body.contains("href=\"/impressum\">German version</a>"),
            "{body}"
        );
        assert!(body.contains("Liability for content"), "{body}");
        assert!(body.contains("Liability for links"), "{body}");
        assert!(
            body.contains("Map data © OpenStreetMap contributors"),
            "{body}"
        );
        assert_eq!(meta.title.as_deref(), Some("Legal notice"));
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/impressum")
        );
    }

    #[test]
    fn impressum_german_is_the_pages_body() {
        let (body, _) = impressum(Lang::De);
        assert!(body.contains("Angaben gemäß § 5 TMG"), "{body}");
        assert!(body.contains("Am Kappelgarten 24"), "{body}");
        assert!(body.contains("Haftung für Inhalte"), "{body}");
        assert!(
            body.contains(
                "href=\"https://www.gnu.org/licenses/agpl-3.0.de.html\">AGPL-3.0-or-later</a>"
            ),
            "{body}"
        );
    }

    #[test]
    fn datenschutz_english_is_the_legalprose_body() {
        let (body, meta) = datenschutz(Lang::En);
        assert!(body.contains("<h1 class=\"font-display text-4xl tracking-wide text-fg sm:text-5xl\">Privacy policy</h1>"), "{body}");
        assert!(body.contains("We store as little as possible."), "{body}");
        assert!(body.contains("Session cookie"), "{body}");
        assert!(body.contains("__Host-tk_sess"), "{body}");
        assert!(
            body.contains(
                "The Hessian Commissioner for Data Protection and Freedom of Information"
            ),
            "{body}"
        );
        assert!(
            body.contains("Android app (Trusted Web Activity)"),
            "{body}"
        );
        assert!(
            body.contains("We will announce material changes before they take effect."),
            "{body}"
        );
        assert_eq!(
            meta.canonical_url.as_deref(),
            Some("https://trinkhallen.app/datenschutz")
        );
    }

    #[test]
    fn datenschutz_german_is_the_pages_body() {
        let (body, _) = datenschutz(Lang::De);
        assert!(body.contains("Datenschutzerklärung"), "{body}");
        assert!(body.contains("Login per E-Mail (Magic Link)"), "{body}");
        assert!(
            body.contains("Der Hessische Beauftragte für Datenschutz und Informationsfreiheit"),
            "{body}"
        );
    }
}
