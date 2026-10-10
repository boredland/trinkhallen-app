//! `report` island: `ReportForm.tsx` + the `kind` → fieldset toggling from
//! `src/client/app.entry.ts`. The form itself is a plain POST to
//! `/api/reports` (the server redirects) — only the visible fieldset is
//! interactive.

use dioxus::prelude::*;
use serde::{Deserialize, Serialize};
use trinkhallen_core::i18n::{Lang, path_for_lang, report_kind_label, report_status_label, t};

use crate::model::UserKioskReport;

pub const NAME: &str = "report";

/// Options of the `kind` select, in render order.
const KINDS: [(&str, &str); 5] = [
    ("wrong_hours", "reportForm.kindWrongHours"),
    ("wrong_address", "reportForm.kindWrongAddress"),
    ("closed", "reportForm.kindClosed"),
    ("duplicate", "reportForm.kindDuplicate"),
    ("other", "reportForm.kindOther"),
];

#[derive(Props, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportProps {
    pub lang: Lang,
    pub kiosk_id: String,
    pub is_logged_in: bool,
    /// Pre-filled hours text from the kiosk for the wrong_hours flow.
    pub current_hours_raw: Option<String>,
    /// Reports this user already filed for this kiosk that are still in
    /// flight or accepted: their `kind` drops out of the select.
    pub user_reports: Vec<UserKioskReport>,
}

impl ReportProps {
    pub fn new(
        lang: Lang,
        kiosk_id: &str,
        is_logged_in: bool,
        current_hours_raw: Option<&str>,
        user_reports: &[UserKioskReport],
    ) -> Self {
        ReportProps {
            lang,
            kiosk_id: kiosk_id.to_owned(),
            is_logged_in,
            current_hours_raw: current_hours_raw.map(str::to_owned),
            user_reports: user_reports.to_vec(),
        }
    }

    #[cfg(test)]
    pub fn sample() -> Self {
        ReportProps::new(Lang::De, "tk_fr_1", true, None, &[])
    }

    fn available_kinds(&self) -> Vec<(&'static str, &'static str)> {
        KINDS
            .iter()
            .copied()
            .filter(|(value, _)| !self.user_reports.iter().any(|r| r.kind == *value))
            .collect()
    }
}

/// Pre-rendered island wrapper used by `pages::kiosk::detail`.
pub fn render_fragment(props: &ReportProps) -> String {
    crate::render::island("report-island", NAME, ReportIsland, props.clone())
}

#[allow(non_snake_case)]
pub fn ReportIsland(props: ReportProps) -> Element {
    let lang = props.lang;

    if !props.is_logged_in {
        let href = path_for_lang("/me", lang);
        return rsx! {
            p { class: "text-sm text-fg-muted",
                a { href: "{href}", class: "text-neon-cyan underline underline-offset-2", "{t(lang, \"auth.login\")}" }
                " {t(lang, \"reportForm.loginHint\")}"
            }
        };
    }

    let available = props.available_kinds();
    let exhausted = available.is_empty();
    let hours_placeholder = props
        .current_hours_raw
        .clone()
        .unwrap_or_else(|| "z. B. Mo-Fr 09:00-22:00; Sa 10:00-20:00".to_owned());
    // Starts empty so the pre-hydration markup keeps every fieldset hidden,
    // exactly like the TS SSR; the mount effect reveals the selected one the
    // way `apply()` did on load.
    let mut selected = use_signal(String::new);
    {
        let mut selected = selected;
        let first = available.first().map(|(v, _)| (*v).to_owned());
        use_effect(move || {
            if selected.peek().is_empty() {
                if let Some(first) = first.clone() {
                    selected.set(first);
                }
            }
        });
    }

    rsx! {
        div { class: "space-y-3", "data-report-form": "",
            if !props.user_reports.is_empty() {
                {submitted_panel(lang, &props.user_reports)}
            }
            if exhausted {
                p { class: "text-sm text-fg-muted", "{t(lang, \"reportForm.allReported\")}" }
            } else {
                details { class: "text-sm",
                    summary { class: "cursor-pointer font-display tracking-wider uppercase text-fg-muted hover:text-neon-pink",
                        "{t(lang, \"reportForm.toggle\")}"
                    }
                    form {
                        action: "/api/reports",
                        method: "post",
                        class: "mt-4 space-y-3",
                        input { r#type: "hidden", name: "kiosk_id", value: "{props.kiosk_id}" }

                        label { class: "block",
                            span { class: "block text-xs uppercase tracking-wider text-fg-dim",
                                "{t(lang, \"reportForm.whatsWrong\")}"
                            }
                            select {
                                name: "kind",
                                required: true,
                                class: "mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none",
                                onchange: move |evt: FormEvent| selected.set(evt.value()),
                                for (value, label_key) in &available {
                                    option {
                                        value: "{value}",
                                        selected: selected.read().as_str() == *value,
                                        "{t(lang, label_key)}"
                                    }
                                }
                            }
                        }

                        {fieldset("wrong_hours", &selected, rsx! {
                            legend { class: "block text-xs uppercase tracking-wider text-fg-dim",
                                "{t(lang, \"reportForm.correctTimes\")}"
                            }
                            input {
                                r#type: "text",
                                name: "new_hours",
                                placeholder: "{hours_placeholder}",
                                class: "w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 font-mono text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none",
                            }
                            p { class: "text-xs text-fg-dim",
                                "{t(lang, \"reportForm.osmFormatPre\")}"
                                code { "opening_hours" }
                                "{t(lang, \"reportForm.osmFormatPost\")}"
                            }
                        })}

                        {fieldset("wrong_address", &selected, rsx! {
                            legend { class: "block text-xs uppercase tracking-wider text-fg-dim",
                                "{t(lang, \"reportForm.correctAddress\")}"
                            }
                            input {
                                r#type: "text",
                                name: "new_street",
                                placeholder: "{t(lang, \"reportForm.street\")}",
                                class: "w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none",
                            }
                            div { class: "grid grid-cols-2 gap-2",
                                input {
                                    r#type: "text",
                                    name: "new_number",
                                    placeholder: "{t(lang, \"reportForm.number\")}",
                                    class: "border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none",
                                }
                                input {
                                    r#type: "text",
                                    name: "new_postalcode",
                                    placeholder: "{t(lang, \"reportForm.postalcode\")}",
                                    maxlength: "5",
                                    class: "border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none",
                                }
                            }
                            input {
                                r#type: "text",
                                name: "new_city",
                                placeholder: "{t(lang, \"reportForm.city\")}",
                                class: "w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none",
                            }
                        })}

                        label { class: "block",
                            span { class: "block text-xs uppercase tracking-wider text-fg-dim",
                                "{t(lang, \"reportForm.noteOptional\")}"
                            }
                            textarea {
                                name: "note",
                                rows: "2",
                                maxlength: "500",
                                placeholder: "{t(lang, \"reportForm.notePlaceholder\")}",
                                class: "mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none",
                            }
                        }

                        button { r#type: "submit", class: "btn-neon", "{t(lang, \"reportForm.submit\")}" }
                        p { class: "text-xs text-fg-dim", "{t(lang, \"reportForm.moderated\")}" }
                    }
                }
            }
        }
    }
}

/// `class="hidden space-y-2"` until this kind is the selected one.
fn fieldset(kind: &'static str, selected: &Signal<String>, body: Element) -> Element {
    let hidden = selected.read().as_str() != kind;
    rsx! {
        fieldset {
            "data-kind": "{kind}",
            class: if hidden { "hidden space-y-2" } else { "space-y-2" },
            {body}
        }
    }
}

fn submitted_panel(lang: Lang, reports: &[UserKioskReport]) -> Element {
    rsx! {
        div { class: "border-2 border-border bg-surface-2 p-3 text-sm",
            p { class: "mb-2 text-xs uppercase tracking-wider text-fg-dim",
                "{t(lang, \"reportForm.alreadyReported\")}"
            }
            ul { class: "space-y-1",
                for r in reports {
                    li { class: "flex items-center justify-between gap-2",
                        span { class: "text-fg", "{report_kind_label(lang, &r.kind)}" }
                        span { class: "font-display text-xs tracking-wider uppercase text-fg-muted",
                            "{report_status_label(lang, &r.status)}"
                        }
                    }
                }
            }
        }
    }
}
