//! `/moderate` (`src/routes/moderate.tsx`): the moderation queue page.
//!
//! Stored JSON payloads are untrusted input: a row that does not parse renders
//! its raw text instead of taking the whole queue down (the TS `JSON.parse`
//! threw and returned a 500).

use dioxus::prelude::*;
use trinkhallen_core::i18n::{Lang, t, tag_label, tpl};

use crate::components::shared::fmt_date;
use crate::model::{Nav, Role};
use crate::pages::{ModTab, ModerateData, PageMeta};
use crate::render::{ClientEntry, to_html};

pub fn render(data: &ModerateData) -> (String, PageMeta) {
    let lang = data.lang;
    let counts = (
        data.submissions.len(),
        data.reports.len(),
        data.users.len(),
        data.anomalies.len(),
    );
    let body = to_html(rsx! {
        header { class: "mb-6 flex items-end justify-between",
            h1 { class: "font-display text-4xl tracking-wide text-fg", "{t(lang, \"mod.title\")}" }
            p { class: "text-xs uppercase tracking-wider text-fg-dim", "{data.role.code()}" }
        }

        nav { class: "mb-6 flex gap-2 border-b-2 border-border",
            {tab_link("/moderate?tab=submissions", matches!(data.tab, ModTab::Submissions), tpl(lang, "mod.tabSubmissions", &[("n", &counts.0)]))}
            {tab_link("/moderate?tab=reports", matches!(data.tab, ModTab::Reports), tpl(lang, "mod.tabReports", &[("n", &counts.1)]))}
            {tab_link("/moderate?tab=users", matches!(data.tab, ModTab::Users), tpl(lang, "mod.tabUsers", &[("n", &counts.2)]))}
            {tab_link("/moderate?tab=anomalies", matches!(data.tab, ModTab::Anomalies), tpl(lang, "mod.tabAnomalies", &[("n", &counts.3)]))}
        }

        {
            match data.tab {
                ModTab::Submissions => submission_queue(lang, data),
                ModTab::Reports => report_queue(lang, data),
                ModTab::Users => users_queue(lang, data),
                ModTab::Anomalies => anomalies_queue(lang, data),
            }
        }
    });

    let meta = PageMeta {
        title: Some("Moderation".to_string()),
        noindex: true,
        entries: vec![ClientEntry::App],
        nav: Some(Nav::Me),
        ..Default::default()
    };
    (body, meta)
}

/// `@handle` when present, else the email local part (the TS falls back to
/// `user_email.split("@")[0]`).
fn byline(username: &Option<String>, email: &Option<String>) -> String {
    match username {
        Some(u) => format!("@{u}"),
        None => email
            .as_deref()
            .and_then(|e| e.split('@').next())
            .unwrap_or_default()
            .to_owned(),
    }
}

fn tab_link(href: &str, active: bool, label: String) -> Element {
    let cls = if active {
        "-mb-0.5 border-b-2 px-3 py-2 font-display text-sm tracking-wider uppercase transition-colors border-neon-pink text-neon-pink"
    } else {
        "-mb-0.5 border-b-2 px-3 py-2 font-display text-sm tracking-wider uppercase transition-colors border-transparent text-fg-muted hover:text-fg"
    };
    rsx! {
        a { href: "{href}", class: "{cls}", "{label}" }
    }
}

fn empty_queue(lang: Lang, label: &str) -> Element {
    rsx! {
        div { class: "border-2 border-border bg-surface p-6 text-fg-muted",
            p { class: "font-display text-xl tracking-wide text-fg", "▶▶▶ {t(lang, \"mod.emptyHeading\")}" }
            p { class: "mt-2 text-sm", "{label}" }
        }
    }
}

fn approve_reject(lang: Lang, endpoint: &str) -> Element {
    rsx! {
        div { class: "flex flex-col gap-2 sm:flex-row sm:items-end",
            form { action: "{endpoint}/approve", method: "post",
                button {
                    r#type: "submit",
                    class: "btn-neon",
                    style: "background:#4ADE80;color:#0a0a0a",
                    "✓ Approve"
                }
            }
            form { action: "{endpoint}/reject", method: "post", class: "flex flex-1 items-end gap-2",
                label { class: "flex-1",
                    span { class: "sr-only", "Begründung" }
                    input {
                        r#type: "text",
                        name: "note",
                        placeholder: "{t(lang, \"mod.reason\")}",
                        class: "w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none",
                    }
                }
                button {
                    r#type: "submit",
                    class: "border-2 border-danger px-3 py-1.5 font-display text-sm tracking-wider uppercase text-danger hover:bg-danger hover:text-bg",
                    "✗ Reject"
                }
            }
        }
    }
}

/// `JSON.stringify(x, null, 2)` for payloads that parse; the raw text for
/// those that don't.
fn pretty(payload: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(payload) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
        Err(_) => payload.to_owned(),
    }
}

fn submission_queue(lang: Lang, data: &ModerateData) -> Element {
    if data.submissions.is_empty() {
        return empty_queue(lang, &t(lang, "mod.noSubmissions"));
    }
    let items: Vec<Element> = data
        .submissions
        .iter()
        .map(|s| {
            // A malformed payload must not blank the queue: show what we know
            // from the row itself and the raw payload in the JSON fold.
            let parsed = serde_json::from_str::<serde_json::Value>(&s.payload);
            let (name, lng, lat, address, description, hours, tags, json) = match &parsed {
                Ok(v) => (
                    v["properties"]["name"].as_str().unwrap_or("(ohne Name)").to_owned(),
                    v["geometry"]["coordinates"][0].as_f64().unwrap_or_default(),
                    v["geometry"]["coordinates"][1].as_f64().unwrap_or_default(),
                    address_line(v),
                    v["properties"]["description"].as_str().map(str::to_owned),
                    v["properties"]["hours"]["raw"].as_str().map(str::to_owned),
                    v["properties"]["tags"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|t| t.as_str())
                                .map(|slug| tag_label(lang, slug))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                    serde_json::to_string_pretty(v).unwrap_or_default(),
                ),
                Err(_) => {
                    (s.id.clone(), 0.0, 0.0, String::new(), None, None, Vec::new(), s.payload.clone())
                }
            };
            let by = byline(&s.user_username, &s.user_email);
            let created = fmt_date(s.created_at, Lang::De);
            let endpoint = format!("/api/moderate/submissions/{}", s.id);
            rsx! {
                li { class: "border-2 border-border bg-surface p-5",
                    header { class: "flex flex-wrap items-baseline justify-between gap-2",
                        h2 { class: "font-display text-2xl tracking-wide text-fg", "{name}" }
                        p { class: "text-xs text-fg-dim", "{t(lang, \"mod.by\")} {by} · {created}" }
                    }
                    p { class: "mt-1 font-mono text-sm text-fg-muted", "{lat:.5}, {lng:.5}" }
                    if !address.is_empty() {
                        p { class: "mt-2 text-sm text-fg-muted", "{address}" }
                    }
                    if let Some(description) = &description {
                        p { class: "mt-2 text-fg-muted", "{description}" }
                    }
                    if let Some(hours) = &hours {
                        p { class: "mt-2 font-mono text-sm text-fg", "{hours}" }
                    }
                    if !tags.is_empty() {
                        ul { class: "mt-2 flex flex-wrap gap-1.5",
                            for tag in &tags {
                                li { class: "border-2 border-border-hi px-2 py-0.5 text-xs text-fg-muted", "{tag}" }
                            }
                        }
                    }
                    details { class: "mt-3 text-xs",
                        summary { class: "cursor-pointer text-fg-dim hover:text-fg", "JSON" }
                        pre { class: "mt-2 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted", "{json}" }
                    }
                    div { class: "mt-4", {approve_reject(lang, &endpoint)} }
                }
            }
        })
        .collect();
    rsx! {
        ul { class: "space-y-4", {items.into_iter()} }
    }
}

fn address_line(v: &serde_json::Value) -> String {
    let a = &v["properties"]["address"];
    let parts: Vec<&str> = ["street", "number", "postalcode", "city"]
        .iter()
        .filter_map(|k| a[*k].as_str())
        .collect();
    let mut line = parts.join(" ");
    if let Some(d) = a["district"].as_str() {
        line.push_str(&format!(" · {d}"));
    }
    line
}

fn report_queue(lang: Lang, data: &ModerateData) -> Element {
    if data.reports.is_empty() {
        return empty_queue(lang, &t(lang, "mod.noReports"));
    }
    let items: Vec<Element> = data
        .reports
        .iter()
        .map(|r| {
            let json = r.payload.as_deref().map(pretty).unwrap_or_else(|| "{}".to_string());
            let by = byline(&r.user_username, &r.user_email);
            let created = fmt_date(r.created_at, Lang::De);
            let endpoint = format!("/api/moderate/reports/{}", r.id);
            let kiosk_href = format!("/k/{}", r.kiosk_id);
            rsx! {
                li { class: "border-2 border-border bg-surface p-5",
                    header { class: "flex flex-wrap items-baseline justify-between gap-2",
                        h2 { class: "font-display text-lg tracking-wide text-fg",
                            a { class: "hover:text-neon-pink", href: "{kiosk_href}", "{r.kiosk_name}" }
                        }
                        p { class: "text-xs text-fg-dim", "{t(lang, \"mod.by\")} {by} · {created}" }
                    }
                    p { class: "mt-1 text-sm",
                        span { class: "border-2 border-border px-2 py-0.5 font-display text-xs tracking-wider uppercase text-neon-amber", "{r.kind}" }
                    }
                    pre { class: "mt-3 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted", "{json}" }
                    div { class: "mt-4", {approve_reject(lang, &endpoint)} }
                }
            }
        })
        .collect();
    rsx! {
        ul { class: "space-y-4", {items.into_iter()} }
    }
}

fn users_queue(lang: Lang, data: &ModerateData) -> Element {
    if data.users.is_empty() {
        return empty_queue(lang, &t(lang, "mod.noUsers"));
    }
    let items: Vec<Element> = data
        .users
        .iter()
        .map(|u| {
            let fmt = |unix: i64| fmt_date(unix, Lang::De);
            let banned = u.banned_at;
            let name = match &u.username {
                Some(name) => format!("@{name}"),
                None => u.email.clone(),
            };
            let row_cls = if banned.is_some() {
                "flex flex-wrap items-center gap-4 p-4 bg-danger/5"
            } else {
                "flex flex-wrap items-center gap-4 p-4"
            };
            let btn_cls = if banned.is_some() {
                "cursor-pointer border-2 border-neon-cyan px-3 py-1.5 font-display text-sm tracking-wide text-neon-cyan hover:bg-neon-cyan hover:text-bg"
            } else {
                "cursor-pointer border-2 border-danger px-3 py-1.5 font-display text-sm tracking-wide text-danger hover:bg-danger hover:text-bg"
            };
            let action = if banned.is_some() { "unban" } else { "ban" };
            rsx! {
                li { class: "{row_cls}",
                    div { class: "min-w-0 flex-1",
                        p { class: "font-display text-sm tracking-wide text-fg",
                            if u.username.is_some() {
                                span { class: "font-mono text-neon-cyan", "{name}" }
                            } else {
                                "{name}"
                            }
                            if u.role != Role::User {
                                span { class: "ml-2 border border-border-hi px-1.5 py-0.5 text-xs uppercase tracking-wider text-fg-muted", "{u.role.code()}" }
                            }
                            if let Some(banned_at) = banned {
                                span { class: "ml-2 border-2 border-danger bg-danger/10 px-1.5 py-0.5 text-xs uppercase tracking-wider text-danger",
                                    "banned · {fmt(banned_at)}"
                                }
                            }
                        }
                        p { class: "mt-1 text-xs text-fg-dim", "{u.email} · seit {fmt(u.created_at)}" }
                        p { class: "mt-1 text-xs font-mono tabular-nums text-fg-muted",
                            "ratings={u.ratings_count} · reports={u.reports_count} · submissions={u.submissions_count} · checkins={u.checkins_count}"
                        }
                    }
                    form { action: "/api/moderate/users/{u.id}/{action}", method: "post",
                        button {
                            r#type: "submit",
                            class: "{btn_cls}",
                            if banned.is_some() {
                                "{t(lang, \"mod.unban\")}"
                            } else {
                                "{t(lang, \"mod.shadowban\")}"
                            }
                        }
                    }
                }
            }
        })
        .collect();
    rsx! {
        ul { class: "divide-y-2 divide-border border-2 border-border bg-surface", {items.into_iter()} }
    }
}

fn anomalies_queue(lang: Lang, data: &ModerateData) -> Element {
    if data.anomalies.is_empty() {
        return empty_queue(lang, &t(lang, "mod.noAnomalies"));
    }
    let items: Vec<Element> = data
        .anomalies
        .iter()
        .map(|a| {
            let json = a.payload.as_deref().map(pretty).unwrap_or_else(|| "{}".to_string());
            let by = byline(&a.user_username, &a.user_email);
            let created = fmt_date(a.created_at, Lang::De);
            rsx! {
                li { class: "border-2 border-border bg-surface p-5",
                    header { class: "flex flex-wrap items-baseline justify-between gap-2",
                        h2 { class: "font-display text-lg tracking-wide text-fg", "{by}" }
                        p { class: "text-xs text-fg-dim",
                            span { class: "border-2 border-border px-2 py-0.5 font-display text-xs tracking-wider uppercase text-neon-amber", "{a.kind}" }
                            " · {created}"
                        }
                    }
                    pre { class: "mt-3 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted", "{json}" }
                }
            }
        })
        .collect();
    rsx! {
        ul { class: "space-y-4", {items.into_iter()} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{ModAnomaly, ModReport, ModSubmission, ModUser};

    fn data() -> ModerateData {
        ModerateData {
            lang: Lang::De,
            role: Role::Moderator,
            tab: ModTab::Submissions,
            submissions: vec![ModSubmission {
                id: "s1".into(),
                payload: r#"{"geometry":{"coordinates":[8.689,50.123]},"properties":{"name":"Kayo","address":{"street":"X","number":"1","postalcode":"60311","city":"Frankfurt am Main","district":"Mitte"},"description":"fein","hours":{"raw":"Mo-Fr 08:00-20:00"},"tags":["wc"]}}"#.into(),
                created_at: 0,
                user_username: Some("pfand_pirat".into()),
                user_email: Some("du@beispiel.de".into()),
            }],
            reports: vec![ModReport {
                id: "r1".into(),
                kiosk_id: "tk_fr_42".into(),
                kiosk_name: "Testkiosk".into(),
                kind: "wrong_hours".into(),
                payload: Some(r#"{"new_hours":"Mo-Fr 09:00-22:00"}"#.into()),
                created_at: 0,
                user_username: None,
                user_email: Some("du@beispiel.de".into()),
            }],
            users: vec![ModUser {
                id: "u1".into(),
                email: "du@beispiel.de".into(),
                username: Some("pfand_pirat".into()),
                role: Role::User,
                banned_at: None,
                created_at: 0,
                ratings_count: 1,
                reports_count: 2,
                submissions_count: 3,
                checkins_count: 4,
            }],
            anomalies: vec![ModAnomaly {
                id: "a1".into(),
                user_id: "u1".into(),
                kind: "burst".into(),
                payload: None,
                created_at: 0,
                user_username: Some("pfand_pirat".into()),
                user_email: Some("du@beispiel.de".into()),
            }],
        }
    }

    #[test]
    fn queue_tabs_and_actions() {
        let (body, meta) = render(&data());
        assert!(
            body.contains("href=\"/moderate?tab=submissions\""),
            "{body}"
        );
        assert!(body.contains("href=\"/moderate?tab=reports\""), "{body}");
        assert!(body.contains("href=\"/moderate?tab=users\""), "{body}");
        assert!(body.contains("href=\"/moderate?tab=anomalies\""), "{body}");
        assert!(body.contains("Vorschläge (1)"), "{body}");
        assert!(
            body.contains("<form action=\"/api/moderate/submissions/s1/approve\" method=\"post\">"),
            "{body}"
        );
        assert!(
            body.contains("<form action=\"/api/moderate/submissions/s1/reject\" method=\"post\""),
            "{body}"
        );
        assert!(body.contains("name=\"note\""), "{body}");
        assert!(body.contains("Kayo"), "{body}");
        assert!(body.contains("50.12300, 8.68900"), "{body}");
        assert_eq!(meta.title.as_deref(), Some("Moderation"));
        assert!(meta.noindex);
    }

    #[test]
    fn other_tabs_render_their_queues() {
        let mut d = data();
        d.tab = ModTab::Reports;
        let (body, _) = render(&d);
        assert!(
            body.contains("href=\"/k/tk_fr_42\">Testkiosk</a>"),
            "{body}"
        );
        assert!(body.contains("/api/moderate/reports/r1/approve"), "{body}");

        d.tab = ModTab::Users;
        let (body, _) = render(&d);
        assert!(body.contains("/api/moderate/users/u1/ban"), "{body}");
        assert!(
            body.contains("ratings=1 · reports=2 · submissions=3 · checkins=4"),
            "{body}"
        );

        d.tab = ModTab::Anomalies;
        let (body, _) = render(&d);
        assert!(body.contains("burst"), "{body}");
    }

    #[test]
    fn malformed_payload_renders_as_raw_text() {
        let mut d = data();
        d.submissions[0].payload = "{not json".into();
        let (body, _) = render(&d);
        // The row still renders (raw payload in the JSON fold) instead of 500ing.
        assert!(body.contains("{not json"), "{body}");
        assert!(
            body.contains("/api/moderate/submissions/s1/approve"),
            "{body}"
        );

        d.reports[0].payload = Some("[1, 2".into());
        d.tab = ModTab::Reports;
        let (body, _) = render(&d);
        assert!(body.contains("[1, 2"), "{body}");
    }

    #[test]
    fn empty_queue_shows_the_clean_inbox() {
        let mut d = data();
        d.submissions.clear();
        let (body, _) = render(&d);
        assert!(body.contains("▶▶▶ Saubere Inbox"), "{body}");
        assert!(body.contains("Keine offenen Vorschläge."), "{body}");
    }
}
