//! `/me`: the logged-out login page and the profile
//! (`renderProfile`), including the flash banners and the account forms.

use dioxus::prelude::*;
use trinkhallen_core::i18n::{Lang, path_for_lang, report_kind_label, status_pill_label, t};

use crate::components::shared::fmt_date;
use crate::model::Nav;
use crate::pages::{LoginData, PageMeta, ProfileData};
use crate::render::{ClientEntry, to_html};

pub fn login(data: &LoginData) -> (String, PageMeta) {
    let lang = data.lang;
    let magic = data.magic.as_deref();
    // The magic-link banners are plain German copy in both locales.
    let ok = "mt-6 border-2 border-success/60 bg-success/10 p-4 text-success";
    let err = "mt-6 border-2 border-danger/60 bg-danger/10 p-4 text-danger";
    let banners = match magic {
        Some("sent") => rsx! {
            div { class: "{ok}", "▶▶▶ Check deinen Posteingang. Der Link ist 15 Minuten gültig." }
        },
        Some("invalid") => rsx! {
            div { class: "{err}", "Diese E-Mail-Adresse sieht nicht gültig aus." }
        },
        Some("expired") => rsx! {
            div { class: "{err}", "Der Login-Link ist abgelaufen oder schon verwendet. Forder einen neuen an." }
        },
        Some("robot") => rsx! {
            div { class: "{err}", "Die Bot-Prüfung ist fehlgeschlagen. Lade die Seite neu und versuch es nochmal." }
        },
        _ => rsx! {},
    };

    let apple_cls = "mt-6 inline-flex w-full items-center justify-center gap-3 border-2 border-border-hi bg-surface-2 px-3 py-2.5 font-display tracking-wider uppercase text-fg transition-colors hover:border-neon-pink hover:text-neon-pink";
    let google_cls = apple_cls.replace("mt-6", "mt-3");

    let body = to_html(rsx! {
        section { class: "border-2 border-border bg-surface p-8",
            h1 { class: "font-display text-3xl tracking-wide text-fg sm:text-4xl", "Anmelden" }
            p { class: "mt-3 text-fg-muted",
                "Anmelden, um Spätis zu bewerten und Korrekturen einzureichen. Anonyme Nutzung der Karte bleibt jederzeit möglich."
            }
            {banners}

            a { href: "/auth/apple", class: apple_cls,
                span { aria_hidden: "true", "▶" }
                " Mit Apple anmelden"
            }
            a { href: "/auth/google", class: google_cls,
                span { aria_hidden: "true", "▶" }
                " Mit Google anmelden"
            }

            div { class: "my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-fg-dim",
                span { class: "h-px flex-1 bg-border", aria_hidden: "true" }
                "oder"
                span { class: "h-px flex-1 bg-border", aria_hidden: "true" }
            }

            form { action: "/auth/magic", method: "post", class: "flex flex-col gap-3",
                div { class: "flex flex-col gap-3 sm:flex-row sm:items-stretch",
                    label { class: "flex-1",
                        span { class: "sr-only", "E-Mail-Adresse" }
                        input {
                            r#type: "email",
                            name: "email",
                            required: true,
                            placeholder: "du@beispiel.de",
                            class: "w-full border-2 border-border-hi bg-surface-2 px-3 py-2.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none",
                        }
                    }
                    button { r#type: "submit", class: "btn-neon shrink-0", "▶ Login-Link per Mail" }
                }
                // Must stay inside the form — the widget injects its
                // cf-turnstile-response input into the enclosing form.
                if let Some(site_key) = &data.turnstile_site_key {
                    div {
                        class: "cf-turnstile",
                        "data-sitekey": "{site_key}",
                        "data-action": "turnstile-spin-v1",
                        "data-theme": "dark",
                    }
                }
            }

            p { class: "mt-6 text-xs text-fg-dim",
                "Wir speichern nur deine E-Mail-Adresse und einen automatisch erzeugten Handle. Keinen Namen, kein Profilbild, keine Tracker."
            }
        }
    });

    // The Turnstile loader sits between the form and the note; since
    // rsx cannot mix raw tags with elements, splice it into the section.
    let body = match &data.turnstile_site_key {
        Some(_) => {
            let script = format!(
                "<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" nonce=\"{}\" async defer></script>",
                crate::components::layout::html_escape(&data.nonce),
            );
            body.replacen("</section>", &format!("{script}</section>"), 1)
        }
        None => body,
    };

    let meta = PageMeta {
        title: Some(t(lang, "auth.login")),
        noindex: true,
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Me),
        ..Default::default()
    };
    (body, meta)
}

pub fn profile(data: &ProfileData) -> (String, PageMeta) {
    let lang = data.lang;
    let user = &data.user;
    let fmt = |unix: i64| fmt_date(unix, Lang::De);
    let initial = user
        .username
        .as_deref()
        .unwrap_or(user.email.as_str())
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_default();
    let heading = match &user.username {
        Some(name) => format!("@{name}"),
        None => user.email.clone(),
    };
    let handle_display = user.username.clone().unwrap_or_else(|| "—".to_string());
    let connect_cls = "inline-flex items-center gap-2 border-2 border-neon-cyan bg-transparent px-3 py-1.5 font-display tracking-wider uppercase text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-bg";

    let body = to_html(rsx! {
        section { class: "border-2 border-border bg-surface p-6",
            div { class: "flex items-center gap-4",
                span { class: "grid h-16 w-16 place-items-center border-2 border-border-hi bg-neon-pink/20 font-display text-2xl text-neon-pink", "{initial}" }
                div {
                    h1 { class: "font-display text-3xl tracking-wide text-fg", "{heading}" }
                    p { class: "text-fg-muted", "{user.email}" }
                    p { class: "mt-1 text-xs uppercase tracking-wider text-fg-dim",
                        "{t(lang, \"profile.role\")} {user.role.code()}"
                    }
                }
            }
            dl { class: "mt-6 grid grid-cols-2 gap-3 text-center sm:grid-cols-5",
                {stat(data.checkins_count, &t(lang, "profile.stat.checkins"))}
                {stat(data.signals_count, &t(lang, "profile.stat.signals"))}
                {stat(data.ratings_count, &t(lang, "profile.stat.ratings"))}
                {stat(data.reports.len() as u64, &t(lang, "profile.stat.corrections"))}
                {stat(data.submissions.len() as u64, &t(lang, "profile.stat.suggestions"))}
            }
            if !user.has_google || !user.has_apple {
                div { class: "mt-6 border-2 border-border-hi bg-surface-2 p-4 space-y-3",
                    p { class: "text-sm text-fg-muted", "{t(lang, \"profile.linkAccounts\")}" }
                    div { class: "flex flex-wrap gap-2",
                        if !user.has_apple {
                            a { href: "/auth/apple", class: connect_cls,
                                span { aria_hidden: "true", "▶" }
                                " {t(lang, \"profile.connectApple\")}"
                            }
                        }
                        if !user.has_google {
                            a { href: "/auth/google", class: connect_cls,
                                span { aria_hidden: "true", "▶" }
                                " {t(lang, \"profile.connectGoogle\")}"
                            }
                        }
                    }
                }
            }
            form { action: "/auth/logout", method: "post", class: "mt-6", "data-logout-form": "",
                button {
                    r#type: "submit",
                    class: "cursor-pointer border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink",
                    "{t(lang, \"profile.logout\")}"
                }
            }
        }

        {flash_banner(lang, data.submitted_flag.as_deref(), "ok", "ok", "profile.flash.submitted")}
        {flash_banner(lang, data.reported_flag.as_deref(), "ok", "ok", "profile.flash.reported")}
        {flash_banner(lang, data.link_flag.as_deref(), "ok", "ok", "profile.flash.linkOk")}
        {flash_banner(lang, data.link_flag.as_deref(), "conflict", "err", "profile.flash.linkConflict")}

        section { class: "mt-6 border-2 border-border bg-surface p-6",
            h2 { class: "font-display text-xl tracking-wide text-fg", "{t(lang, \"profile.handle.heading\")}" }
            p { class: "mt-2 font-mono text-neon-cyan", "@{handle_display}" }
            {handle_flag(lang, data.username_flag.as_deref())}
            if data.can_rename {
                p { class: "mt-4 text-fg-muted",
                    "{t(lang, \"profile.handle.renamePre\")} "
                    strong { "{t(lang, \"profile.handle.renameEmphasis\")}" }
                    " {t(lang, \"profile.handle.renamePost\")}"
                }
                form {
                    action: "{path_for_lang(\"/me/username\", lang)}",
                    method: "post",
                    class: "mt-3 flex flex-col gap-3 sm:flex-row sm:items-stretch",
                    label { class: "flex-1",
                        span { class: "sr-only", "{t(lang, \"profile.handle.newLabel\")}" }
                        input {
                            r#type: "text",
                            name: "username",
                            required: true,
                            minlength: "3",
                            maxlength: "24",
                            pattern: "[A-Za-z0-9_]{{3,24}}",
                            autocapitalize: "none",
                            autocorrect: "off",
                            autocomplete: "off",
                            spellcheck: "false",
                            placeholder: "z.B. pfand_pirat",
                            class: "w-full border-2 border-border-hi bg-surface-2 px-3 py-2.5 font-mono lowercase text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none",
                        }
                    }
                    button { r#type: "submit", class: "btn-neon shrink-0", "▶ {t(lang, \"profile.handle.changeBtn\")}" }
                }
            } else {
                p { class: "mt-4 text-fg-dim", "{t(lang, \"profile.handle.fixed\")}" }
            }
        }

        section { class: "mt-6 border-2 border-border bg-surface",
            header { class: "flex items-center justify-between border-b-2 border-border px-4 py-3",
                h2 { class: "font-display text-xl tracking-wide text-fg", "{t(lang, \"profile.stat.suggestions\")}" }
                a {
                    href: "{path_for_lang(\"/add\", lang)}",
                    class: "border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted hover:border-neon-pink hover:text-neon-pink",
                    "{t(lang, \"profile.suggestKiosk\")}"
                }
            }
            if data.submissions.is_empty() {
                p { class: "p-4 text-fg-muted",
                    "{t(lang, \"profile.noSubmissionsPre\")} "
                    a { class: "text-neon-cyan underline underline-offset-2", href: "{path_for_lang(\"/add\", lang)}", "{t(lang, \"profile.noSubmissionsLink\")}" }
                    " {t(lang, \"profile.noSubmissionsPost\")}"
                }
            } else {
                ul { class: "divide-y-2 divide-border",
                    for s in &data.submissions {
                        {
                            // The stored feature is parsed leniently: a malformed row
                            // must not take the page down, so fall back to the
                            // placeholder name.
                            let name = serde_json::from_str::<serde_json::Value>(&s.payload)
                                .ok()
                                .and_then(|v| v["properties"]["name"].as_str().map(str::to_owned))
                                .unwrap_or_else(|| t(lang, "profile.noName"));
                            rsx! {
                                li { class: "px-4 py-3 text-sm",
                                    div { class: "flex flex-wrap items-center justify-between gap-2",
                                        span { class: "font-display text-base tracking-wide text-fg", "{name}" }
                                        span { class: "text-xs text-fg-dim", "{fmt(s.created_at)}" }
                                    }
                                    div { class: "mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted",
                                        {status_pill(lang, &s.status)}
                                        if let Some(url) = &s.pr_url {
                                            a { class: "text-neon-cyan underline underline-offset-2", href: "{url}", "{t(lang, \"profile.prLink\")}" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        section { class: "mt-6 border-2 border-border bg-surface",
            header { class: "border-b-2 border-border px-4 py-3",
                h2 { class: "font-display text-xl tracking-wide text-fg", "{t(lang, \"profile.stat.corrections\")}" }
            }
            if data.reports.is_empty() {
                p { class: "p-4 text-fg-muted", "{t(lang, \"profile.noCorrections\")}" }
            } else {
                ul { class: "divide-y-2 divide-border",
                    for r in &data.reports {
                        {
                            let kiosk_href = path_for_lang(&format!("/k/{}", r.kiosk_id), lang);
                            rsx! {
                                li { class: "px-4 py-3 text-sm",
                                    div { class: "flex flex-wrap items-center justify-between gap-2",
                                        a {
                                            href: "{kiosk_href}",
                                            class: "font-display text-base tracking-wide text-fg hover:text-neon-pink",
                                            "{r.kiosk_name}"
                                        }
                                        span { class: "text-xs text-fg-dim", "{fmt(r.created_at)}" }
                                    }
                                    div { class: "mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted",
                                        span { class: "border-2 border-border px-2 py-0.5", "{report_kind_label(lang, &r.kind)}" }
                                        {status_pill(lang, &r.status)}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        section { class: "mt-12 border-2 border-danger/40 bg-surface p-6",
            h2 { class: "font-display text-xl tracking-wide text-danger", "{t(lang, \"profile.deleteHeading\")}" }
            p { class: "mt-2 text-fg-muted",
                "{t(lang, \"profile.deleteBodyPre\")}"
                a { class: "text-neon-cyan underline underline-offset-2", href: "https://github.com/boredland/trinkhallen-data", "{t(lang, \"profile.deleteBodyLink\")}" }
                "{t(lang, \"profile.deleteBodyPost\")}"
            }
            {flash_banner(lang, data.delete_flag.as_deref(), "unconfirmed", "err", "profile.deleteUnconfirmed")}
            details { class: "mt-4",
                summary { class: "cursor-pointer text-sm uppercase tracking-wider text-fg-muted hover:text-danger",
                    "{t(lang, \"profile.deleteToggle\")}"
                }
                form {
                    action: "{path_for_lang(\"/me/delete\", lang)}",
                    method: "post",
                    class: "mt-4 space-y-3",
                    "data-logout-form": "",
                    label { class: "flex items-start gap-2 text-sm text-fg-muted",
                        input {
                            r#type: "checkbox",
                            name: "confirm",
                            value: "yes",
                            required: true,
                            class: "mt-1 accent-danger",
                        }
                        span { "{t(lang, \"profile.deleteConfirmLabel\")}" }
                    }
                    button {
                        r#type: "submit",
                        class: "cursor-pointer border-2 border-danger px-3 py-1.5 font-display text-sm tracking-wide text-danger transition-colors hover:bg-danger hover:text-bg",
                        "{t(lang, \"profile.deleteButton\")}"
                    }
                }
            }
        }
    });

    let meta = PageMeta {
        title: Some(t(lang, "page.profile.title")),
        noindex: true,
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Me),
        ..Default::default()
    };
    (body, meta)
}

/// Single stat tile.
fn stat(n: u64, label: &str) -> Element {
    rsx! {
        div { class: "border-2 border-border bg-surface-2 py-3",
            div { class: "font-display text-3xl text-status-open tabular-nums", "{n}" }
            div { class: "text-xs uppercase tracking-wider text-fg-muted", "{label}" }
        }
    }
}

/// Request status pill.
fn status_pill(lang: Lang, status: &str) -> Element {
    let cls = match status {
        "open" | "pending" => "border-status-open text-status-open",
        "pr_opened" | "approved" => "border-neon-cyan text-neon-cyan",
        "merged" => "border-success text-success",
        _ => "border-border text-fg-dim",
    };
    let label = status_pill_label(lang, status);
    rsx! {
        span { class: "border-2 px-2 py-0.5 {cls}", "{label}" }
    }
}

/// Success (`ok`) / error (`err`) flash banners behind the query flags.
fn flash_banner(lang: Lang, flag: Option<&str>, value: &str, tone: &str, key: &str) -> Element {
    if flag != Some(value) {
        return rsx! {};
    }
    let (cls, icon) = if tone == "ok" {
        (
            "mt-6 border-2 border-success/60 bg-success/10 p-4 text-success",
            "▶▶▶",
        )
    } else {
        (
            "mt-6 border-2 border-danger/60 bg-danger/10 p-4 text-danger",
            "✗",
        )
    };
    let text = t(lang, key);
    rsx! {
        div { class: "{cls}", "{icon} {text}" }
    }
}

/// The rename-outcome banner inside the handle section.
fn handle_flag(lang: Lang, flag: Option<&str>) -> Element {
    let (cls, key) = match flag {
        Some("ok") => (
            "mt-3 border-2 border-success/60 bg-success/10 p-3 text-success",
            "profile.handle.changed",
        ),
        Some("invalid") => (
            "mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger",
            "profile.handle.invalid",
        ),
        Some("reserved") => (
            "mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger",
            "profile.handle.reserved",
        ),
        Some("taken") => (
            "mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger",
            "profile.handle.taken",
        ),
        Some("retired") => (
            "mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger",
            "profile.handle.retired",
        ),
        Some("unchanged") => (
            "mt-3 border-2 border-border-hi bg-surface-2 p-3 text-fg-muted",
            "profile.handle.unchanged",
        ),
        Some("already_changed") => (
            "mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger",
            "profile.handle.alreadyChanged",
        ),
        _ => return rsx! {},
    };
    let icon = if key == "profile.handle.changed" {
        "▶▶▶ "
    } else {
        ""
    };
    let text = t(lang, key);
    rsx! {
        p { class: "{cls}", "{icon}{text}" }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Role, SessionUser};
    use crate::pages::{ProfileReport, ProfileSubmission};

    fn login_data() -> LoginData {
        LoginData {
            lang: Lang::De,
            magic: Some("sent".into()),
            turnstile_site_key: Some("0xTEST".into()),
            nonce: "n0nce".into(),
        }
    }

    fn profile_data() -> ProfileData {
        ProfileData {
            lang: Lang::De,
            user: SessionUser {
                id: "u1".into(),
                email: "du@beispiel.de".into(),
                username: Some("pfand_pirat".into()),
                role: Role::User,
                is_magic_link_only: true,
                has_google: false,
                has_apple: false,
            },
            reports: vec![ProfileReport {
                id: "r1".into(),
                kiosk_id: "tk_fr_42".into(),
                kiosk_name: "Testkiosk".into(),
                kind: "wrong_hours".into(),
                status: "open".into(),
                pr_url: None,
                created_at: 0,
            }],
            submissions: vec![
                ProfileSubmission {
                    id: "s1".into(),
                    payload: "{\"properties\":{\"name\":\"Kayo am Rebstock\"}}".into(),
                    status: "pending".into(),
                    pr_url: None,
                    created_at: 0,
                },
                // Malformed row: renders the fallback name, never a panic.
                ProfileSubmission {
                    id: "s2".into(),
                    payload: "{not json".into(),
                    status: "pending".into(),
                    pr_url: None,
                    created_at: 0,
                },
            ],
            ratings_count: 3,
            checkins_count: 4,
            signals_count: 5,
            can_rename: true,
            reported_flag: Some("ok".into()),
            submitted_flag: None,
            username_flag: None,
            link_flag: None,
            delete_flag: Some("unconfirmed".into()),
        }
    }

    #[test]
    fn login_page_carries_the_magic_and_sso_flows() {
        let (body, meta) = login(&login_data());
        assert!(
            body.contains("▶▶▶ Check deinen Posteingang. Der Link ist 15 Minuten gültig."),
            "{body}"
        );
        assert!(body.contains("href=\"/auth/apple\""), "{body}");
        assert!(body.contains("href=\"/auth/google\""), "{body}");
        assert!(
            body.contains("<form action=\"/auth/magic\" method=\"post\""),
            "{body}"
        );
        assert!(body.contains("name=\"email\""), "{body}");
        // Turnstile widget inside the form + its loader, nonce'd.
        assert!(body.contains("class=\"cf-turnstile\""), "{body}");
        assert!(body.contains("data-sitekey=\"0xTEST\""), "{body}");
        assert!(
            body.contains("<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" nonce=\"n0nce\" async defer></script>"),
            "{body}"
        );
        assert!(meta.noindex);
    }

    #[test]
    fn profile_posts_to_username_delete_and_logout() {
        let (body, meta) = profile(&profile_data());
        assert!(
            body.contains("<form action=\"/me/username\" method=\"post\""),
            "{body}"
        );
        assert!(body.contains("name=\"username\""), "{body}");
        assert!(
            body.contains("<form action=\"/me/delete\" method=\"post\""),
            "{body}"
        );
        assert!(body.contains("name=\"confirm\" value=\"yes\""), "{body}");
        assert!(
            body.contains("<form action=\"/auth/logout\" method=\"post\""),
            "{body}"
        );
        // Link-account buttons for the missing providers.
        assert!(body.contains("href=\"/auth/apple\""), "{body}");
        assert!(body.contains("href=\"/auth/google\""), "{body}");
        // Flash banners behind the query flags.
        assert!(body.contains("▶▶▶ Hinweis gespeichert. Danke!"), "{body}");
        assert!(
            body.contains("Bitte das Häkchen setzen, um die Löschung zu bestätigen."),
            "{body}"
        );
        // Stats + handle section.
        assert!(body.contains("@pfand_pirat"), "{body}");
        assert!(body.contains("Handle ändern"), "{body}");
        assert!(meta.noindex);
        assert_eq!(meta.title.as_deref(), Some("Profil"));
    }

    #[test]
    fn profile_lists_reports_and_survives_malformed_submissions() {
        let (body, _) = profile(&profile_data());
        assert!(body.contains("Kayo am Rebstock"), "{body}");
        assert!(body.contains("(ohne Name)"), "{body}");
        assert!(body.contains("href=\"/k/tk_fr_42\""), "{body}");
        assert!(body.contains(">Offen</span>"), "{body}");
    }
}
