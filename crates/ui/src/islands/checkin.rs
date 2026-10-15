//! `checkin` island: the check-in button and the report/signal forms.
//!
//! Two responsibilities, one wrapper:
//!   1. the "Ich war hier" button — best-effort geolocation, POSTs
//!      `/api/checkins`, reveals the gap-fill question block;
//!   2. the gap-fill forms (POST `/api/reports`) and the confirm/dispute
//!      signal buttons (POST `/api/signals`).
//!
//! Where a plain-JS client would swap server fragments into the DOM (`form.outerHTML = …`,
//! `block.outerHTML = …`), the island re-renders from state instead and emits
//! the same markup the server fragment carries — same end state, one code
//! path, and no raw HTML injection.

use std::collections::HashMap;

use dioxus::prelude::*;
use serde::{Deserialize, Serialize};
use trinkhallen_core::i18n::{
    Lang, path_for_lang, payment_label, report_kind_label, report_status_label, t, tag_group_label,
    tag_label, tpl,
};
use trinkhallen_core::reports::BLOCKING_STATUSES;
use trinkhallen_core::tags::REPORTABLE_TAG_GROUPS;

use crate::islands::browser;
use crate::model::UserKioskReport;

pub const NAME: &str = "checkin";

/// Cash is the implicit German default — the enrichment never records it, and
/// "can I pay without cash?" lives in cards/contactless/girocard.
const PAYMENT_ORDER: [&str; 3] = ["cards", "contactless", "girocard"];

fn payment_icon(key: &str) -> Option<&'static str> {
    Some(match key {
        "cards" => "💳",
        "contactless" => "📲",
        "girocard" => "🟦",
        _ => return None,
    })
}

fn tag_icon(slug: &str) -> &'static str {
    match slug {
        "backwaren" => "🥨",
        "eis" => "🍦",
        "zeitungen" => "📰",
        "gemischte_tuete" => "🍬",
        "gluecksspiele" => "🎰",
        "innenraum" => "🏠",
        "draussen" => "⛱️",
        "stehtisch" => "🧍",
        "ueberdacht" => "☂️",
        "wc" => "🚻",
        "barrierefrei" => "♿",
        "paketshop" => "📦",
        "wlan" => "📶",
        "geldautomat" => "🏧",
        _ => "•",
    }
}

#[derive(Props, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckinProps {
    pub lang: Lang,
    pub kiosk_id: String,
    pub hours_raw: Option<String>,
    /// `payment[key]` = `"yes" | "no" | "unknown"`.
    pub payment: Vec<(String, String)>,
    pub tags: Vec<String>,
    pub current_name: String,
    pub is_logged_in: bool,
    pub user_reports: Vec<UserKioskReport>,
}

impl CheckinProps {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        lang: Lang,
        kiosk_id: &str,
        hours_raw: Option<&str>,
        payment: Vec<(String, String)>,
        tags: Vec<String>,
        current_name: &str,
        is_logged_in: bool,
        user_reports: Vec<UserKioskReport>,
    ) -> Self {
        CheckinProps {
            lang,
            kiosk_id: kiosk_id.to_owned(),
            hours_raw: hours_raw.map(str::to_owned),
            payment,
            tags,
            current_name: current_name.to_owned(),
            is_logged_in,
            user_reports,
        }
    }

    #[cfg(test)]
    pub fn sample() -> Self {
        CheckinProps::new(
            Lang::De,
            "tk_fr_1",
            None,
            vec![],
            vec![],
            "Testkiosk",
            true,
            vec![],
        )
    }

    fn pays(&self, key: &str) -> Option<&str> {
        self.payment
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Gap detection at render time: groups already answered on the kiosk
    /// don't render at all.
    fn missing_payment(&self) -> Vec<&'static str> {
        PAYMENT_ORDER
            .into_iter()
            .filter(|k| !matches!(self.pays(k), Some("yes") | Some("no")))
            .collect()
    }

    fn settled_payment(&self) -> Vec<&'static str> {
        PAYMENT_ORDER
            .into_iter()
            .filter(|k| matches!(self.pays(k), Some("yes") | Some("no")))
            .collect()
    }

    /// A group is "answered" when this user has a report of that kind in
    /// flight or accepted.
    fn answered(&self, kind: &str) -> Option<&UserKioskReport> {
        self.user_reports.iter().find(|r| {
            r.kind == kind
                && !BLOCKING_STATUSES.is_empty()
                && matches!(
                    r.status.as_str(),
                    "open" | "pending" | "pr_opened" | "approved"
                )
        })
    }
}

/// Pre-rendered island wrapper used by `pages::kiosk::detail`.
pub fn render_fragment(props: &CheckinProps) -> String {
    crate::render::island("checkin-island", NAME, CheckinIsland, props.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Swapped {
    Thanks,
    Duplicate,
}

#[allow(non_snake_case)]
pub fn CheckinIsland(props: CheckinProps) -> Element {
    let lang = props.lang;
    let done = use_signal(|| false);
    let coords = use_signal(|| None::<crate::islands::Coords>);
    // Per form-group swap target after a successful (or duplicate) submit.
    let mut swapped = use_signal(HashMap::<String, Swapped>::new);
    let mut swap_message = use_signal(HashMap::<String, String>::new);
    // field_key → (action, verified) for the confirm/dispute blocks.
    let mut signals = use_signal(HashMap::<String, (String, bool)>::new);
    let mut signal_error = use_signal(HashMap::<String, String>::new);
    // Gap-fill selections, keyed by `pay_<key>` / `tag_<slug>`.
    let tri = use_signal(HashMap::<String, String>::new);
    let mut new_hours = use_signal(String::new);
    let mut new_name = use_signal(String::new);
    let mut busy = use_signal(String::new);

    if !props.is_logged_in {
        let href = path_for_lang("/me", lang);
        return rsx! {
            p { class: "text-sm text-fg-muted",
                a { href: "{href}", class: "text-neon-cyan underline underline-offset-2", "{t(lang, \"auth.login\")}" }
                ", {t(lang, \"checkin.loginToContribute\")}"
            }
        };
    }

    let hours_missing = props.hours_raw.is_none();
    let missing_payment = props.missing_payment();
    let settled_payment = props.settled_payment();

    let checkin_click = {
        let kiosk_id = props.kiosk_id.clone();
        let mut done = done;
        let mut coords = coords;
        move |_| {
            if *done.peek() {
                return;
            }
            done.set(true);
            let kiosk_id = kiosk_id.clone();
            spawn(async move {
                let Some(b) = browser() else { return };
                let fix = b.0.geolocate().await;
                coords.set(fix);
                let mut fields = vec![("kiosk_id".to_string(), kiosk_id)];
                if let Some(c) = fix {
                    fields.push(("lat".to_string(), c.lat.to_string()));
                    fields.push(("lng".to_string(), c.lng.to_string()));
                    fields.push(("accuracy".to_string(), c.accuracy.to_string()));
                }
                // Best-effort: the check-in itself is a bonus, never an error.
                let _ = b.0.post_form("/api/checkins", fields).await;
            });
        }
    };

    rsx! {
        div {
            "data-checkin": "",
            "data-kiosk-id": "{props.kiosk_id}",
            "data-open": if done.read().clone() { "true" } else { "false" },
            // DOM contract: the fix is readable off the
            // wrapper once it lands.
            "data-lat": coords().map(|c| c.lat.to_string()),
            "data-lng": coords().map(|c| c.lng.to_string()),
            "data-accuracy": coords().map(|c| c.accuracy.to_string()),
            class: "space-y-4",
            button {
                r#type: "button",
                "data-checkin-button": "",
                class: "inline-flex cursor-pointer items-center gap-2 border-2 border-neon-pink bg-neon-pink px-4 py-2 text-sm font-bold uppercase tracking-wider text-bg shadow-[var(--shadow-glow-pink)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60",
                disabled: done.read().clone(),
                onclick: checkin_click,
                if done.read().clone() {
                    "{t(lang, \"checkin.thanksWhatMissing\")}"
                } else {
                    span { aria_hidden: "true", "✓" }
                    "{t(lang, \"checkin.iWasHere\")}"
                }
            }

            div {
                "data-checkin-questions": "",
                hidden: !done.read().clone(),
                class: "space-y-5",
                p { class: "text-sm text-fg-dim", "{t(lang, \"checkin.whatMissingHint\")}" }

                if hours_missing {
                    match props.answered("wrong_hours") {
                        Some(r) => { {answered_stub(lang, r)} }
                        None => {
                            {gap_form(
                                lang,
                                "wrong_hours",
                                group_cls(),
                                &mut swapped,
                                &mut swap_message,
                                &mut busy,
                                rsx! {
                                    span { class: label_cls(), "{t(lang, \"checkin.hoursQ\")}" }
                                    input {
                                        r#type: "text",
                                        name: "new_hours",
                                        placeholder: "z.B. Mo-Sa 07:00-22:00; Su 09:00-20:00",
                                        class: format!("font-mono {}", input_cls()),
                                        maxlength: "200",
                                        required: true,
                                        oninput: move |evt| new_hours.set(evt.value()),
                                    }
                                },
                            )}
                        }
                    }
                }
                if let Some(raw) = props.hours_raw.clone() {
                    {
                        let state = signals.read().get("opening_hours").cloned();
                        confirm_block(
                            lang,
                            "opening_hours",
                            rsx! {
                                p { class: "text-sm text-fg-muted", "{t(lang, \"checkin.hoursOk\")}" }
                                p { class: "font-mono text-sm text-fg", "{raw}" }
                            },
                            state,
                            &mut signals,
                            &mut signal_error,
                            &mut busy,
                            &props,
                            coords,
                        )
                    }
                }
                if !missing_payment.is_empty() {
                    match props.answered("update_payment") {
                        Some(r) => { {answered_stub(lang, r)} }
                        None => {
                            {
                                let fields = rsx! {
                                    span { class: label_cls(), "{t(lang, \"checkin.paymentQ\")}" }
                                    div { class: "space-y-2",
                                        for key in missing_payment {
                                            {
                                                let icon = payment_icon(key).unwrap_or("•");
                                                let label = payment_label(lang, key);
                                                let name = format!("pay_{key}");
                                                rsx! {
                                                    fieldset { class: "flex flex-wrap items-center gap-2",
                                                        legend { class: "mr-2 inline-flex items-center gap-1.5 text-sm text-fg",
                                                            span { aria_hidden: "true", "{icon}" }
                                                            "{label}"
                                                        }
                                                        {tri_radio(&name, "yes", t(lang, "radio.yes"), tri.read().get(&name).map(String::as_str) == Some("yes"), false, tri)}
                                                        {tri_radio(&name, "no", t(lang, "radio.no"), tri.read().get(&name).map(String::as_str) == Some("no"), false, tri)}
                                                        {tri_radio(&name, "", t(lang, "radio.unknown"), tri.read().get(&name).map(String::as_str).unwrap_or("") == "", true, tri)}
                                                    }
                                                }
                                            }
                                        }
                                    }
                                };
                                gap_form(lang, "update_payment", group_cls(), &mut swapped, &mut swap_message, &mut busy, fields)
                            }
                        }
                    }
                }
                if !settled_payment.is_empty() {
                    {
                        let joined = settled_payment
                            .iter()
                            .map(|k| {
                                let value = if props.pays(k) == Some("yes") {
                                    t(lang, "payment.yesLower")
                                } else {
                                    t(lang, "payment.noLower")
                                };
                                format!("{}: {value}", payment_label(lang, k))
                            })
                            .collect::<Vec<_>>()
                            .join(" · ");
                        let state = signals.read().get("payment").cloned();
                        confirm_block(
                            lang,
                            "payment",
                            rsx! {
                                p { class: "text-sm text-fg-muted", "{t(lang, \"checkin.paymentOk\")}" }
                                p { class: "font-mono text-sm text-fg", "{joined}" }
                            },
                            state,
                            &mut signals,
                            &mut signal_error,
                            &mut busy,
                            &props,
                            coords,
                        )
                    }
                }
                match props.answered("update_tags") {
                    Some(r) => { {answered_stub(lang, r)} }
                    None => {
                        {
                            let fields = rsx! {
                                span { class: label_cls(), "{t(lang, \"checkin.amenitiesQ\")}" }
                                for group in REPORTABLE_TAG_GROUPS {
                                    div { class: "space-y-2",
                                        p { class: "font-display text-[0.7rem] tracking-wider uppercase text-fg-dim",
                                            "{tag_group_label(lang, group.label)}"
                                        }
                                        for slug in group.tags {
                                            {
                                                let name = format!("tag_{slug}");
                                                let icon = tag_icon(slug);
                                                let label = tag_label(lang, slug);
                                                let present = props.tags.iter().any(|t| t == slug);
                                                let current = tri.read().get(&name).cloned();
                                                let is_yes = current.as_deref() == Some("yes")
                                                    || (current.is_none() && present);
                                                let is_no = current.as_deref() == Some("no");
                                                rsx! {
                                                    fieldset { class: "flex flex-wrap items-center gap-2",
                                                        legend { class: "mr-2 inline-flex items-center gap-1.5 text-sm text-fg",
                                                            span { aria_hidden: "true", "{icon}" }
                                                            "{label}"
                                                        }
                                                        {tri_radio(&name, "yes", t(lang, "radio.yes"), is_yes, false, tri)}
                                                        {tri_radio(&name, "no", t(lang, "radio.no"), is_no, false, tri)}
                                                        {tri_radio(&name, "", t(lang, "radio.unknown"), !is_yes && !is_no, true, tri)}
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            };
                            gap_form(lang, "update_tags", group_cls(), &mut swapped, &mut swap_message, &mut busy, fields)
                        }
                    }
                }
                {
                    let name_form = gap_form(
                        lang,
                        "wrong_name",
                        "space-y-3 p-4 pt-0",
                        &mut swapped,
                        &mut swap_message,
                        &mut busy,
                        {
                            let name_input_cls = input_cls();
                            rsx! {
                                span { class: label_cls(), "{t(lang, \"checkin.nameLabel\")}" }
                                input {
                                    r#type: "text",
                                    name: "new_name",
                                    placeholder: "{props.current_name}",
                                    class: "{name_input_cls}",
                                    maxlength: "120",
                                    required: true,
                                    oninput: move |evt| new_name.set(evt.value()),
                                }
                            }
                        },
                    );
                    match props.answered("wrong_name") {
                        Some(r) => answered_stub(lang, r),
                        None => rsx! {
                            details { class: "border-2 border-border bg-bg",
                                summary { class: "cursor-pointer px-4 py-3 text-sm text-fg-dim hover:text-fg",
                                    "{t(lang, \"checkin.nameToggle\")}"
                                }
                                {name_form}
                            }
                        },
                    }
                }
            }
        }
    }
}

const fn label_cls() -> &'static str {
    "block font-display text-xs tracking-wider uppercase text-fg-muted"
}

const fn input_cls() -> &'static str {
    "w-full border-2 border-border bg-surface px-2 py-1 text-sm text-fg placeholder:text-fg-dim focus:border-neon-cyan focus:outline-none"
}

const fn submit_cls() -> &'static str {
    "cursor-pointer border-2 border-neon-cyan bg-transparent px-3 py-1 text-xs font-bold uppercase tracking-wider text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-bg"
}

const fn group_cls() -> &'static str {
    "border-2 border-border bg-bg p-4 space-y-3"
}

fn answered_stub(lang: Lang, report: &UserKioskReport) -> Element {
    rsx! {
        p { class: "border-2 border-border bg-bg p-4 text-sm text-fg-muted",
            span { class: "font-display text-xs tracking-wider uppercase text-fg-dim",
                "{report_kind_label(lang, &report.kind)} — "
            }
            span { "{report_status_label(lang, &report.status)}" }
            ". {t(lang, \"checkin.thanks\")}"
        }
    }
}

/// One gap-fill form (or its post-submit swap), posting to `/api/reports`.
fn gap_form(
    lang: Lang,
    kind: &'static str,
    form_cls: &'static str,
    swapped: &mut Signal<HashMap<String, Swapped>>,
    swap_message: &mut Signal<HashMap<String, String>>,
    busy: &mut Signal<String>,
    fields: Element,
) -> Element {
    let kind_key = kind.to_owned();
    if let Some(state) = swapped.read().get(&kind_key).copied() {
        // Matches the fragment `POST /api/reports` returns for
        // `X-Tk-Fragment: 1` (2xx) and the 409 duplicate body.
        return match state {
            Swapped::Thanks => rsx! {
                p { class: "text-sm italic text-fg-dim", "{t(lang, \"reports.thanksReviewing\")}" }
            },
            Swapped::Duplicate => rsx! {
                p { class: "border-2 border-border bg-bg p-4 text-sm italic text-fg-muted",
                    "{swap_message.read().get(&kind_key).cloned().unwrap_or_else(|| t(lang, \"client.alreadyReported\"))}"
                }
            },
        };
    }
    let submit_disabled = busy.read().as_str() == kind;
    rsx! {
        form {
            method: "post",
            action: "/api/reports",
            class: form_cls,
            "data-checkin-form": "1",
            onsubmit: {
                let swapped = *swapped;
                let swap_message = *swap_message;
                let busy = *busy;
                let kind = kind_key.clone();
                move |evt: FormEvent| {
                    evt.prevent_default();
                    let mut fields = vec![
                        ("kiosk_id".to_string(), field_of(&evt, "kiosk_id")),
                        ("kind".to_string(), kind.clone()),
                    ];
                    for (name, value) in evt.values() {
                        if name != "kiosk_id" && name != "kind" {
                            fields.push((name, match value {
                                dioxus::prelude::FormValue::Text(v) => v,
                                _ => String::new(),
                            }));
                        }
                    }
                    let mut swapped = swapped;
                    let mut swap_message = swap_message;
                    let mut busy = busy;
                    let kind = kind.clone();
                    spawn(async move {
                        busy.set(kind.clone());
                        let Some(b) = browser() else { return };
                        match b.0.post_form("/api/reports", fields).await {
                            // 409 = duplicate report (same user, kiosk, kind).
                            Ok(res) if res.status == 409 => {
                                swap_message.write().insert(
                                    kind.clone(),
                                    res.body.trim().to_owned(),
                                );
                                swapped.write().insert(kind.clone(), Swapped::Duplicate);
                            }
                            Ok(res) if res.status < 300 => {
                                swapped.write().insert(kind.clone(), Swapped::Thanks);
                            }
                            _ => {}
                        }
                        busy.set(String::new());
                    });
                }
            },
            {fields}
            button {
                r#type: "submit",
                class: submit_cls(),
                disabled: submit_disabled,
                "{t(lang, \"checkin.send\")}"
            }
        }
    }
}

fn field_of(evt: &dioxus::prelude::FormEvent, name: &str) -> String {
    evt.values()
        .into_iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| match v {
            dioxus::prelude::FormValue::Text(v) => v,
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// The confirm + dispute pair inside every `data-confirm-block`; the client
/// distinguishes via `data-signal-confirm` / `data-signal-dispute` and posts
/// to `/api/signals` with `action=confirm|dispute`.
#[allow(clippy::too_many_arguments)]
fn confirm_block(
    lang: Lang,
    field_key: &'static str,
    body: Element,
    state: Option<(String, bool)>,
    signals: &mut Signal<HashMap<String, (String, bool)>>,
    signal_error: &mut Signal<HashMap<String, String>>,
    busy: &mut Signal<String>,
    props: &CheckinProps,
    coords: Signal<Option<crate::islands::Coords>>,
) -> Element {
    if let Some((action, verified)) = state {
        let verb = if action == "dispute" {
            t(lang, "client.noted")
        } else {
            t(lang, "client.confirmed")
        };
        let msg = if verified {
            tpl(lang, "client.signalOk", &[("verb", &verb)])
        } else {
            tpl(lang, "client.signalLow", &[("verb", &verb)])
        };
        let cls = if verified {
            "border-success/60 bg-success/10 text-success"
        } else {
            "border-neon-amber/60 bg-neon-amber/10 text-neon-amber"
        };
        return rsx! { p { class: "border-2 {cls} p-3 text-sm", "{msg}" } };
    }
    if let Some(msg) = signal_error.read().get(field_key).cloned() {
        return rsx! {
            p { class: "border-2 border-danger/60 bg-danger/10 p-3 text-sm text-danger", "{msg}" }
        };
    }
    let is_busy = !busy.read().is_empty();
    let kiosk_id = props.kiosk_id.clone();
    rsx! {
        div {
            "data-confirm-block": "",
            "data-field-key": "{field_key}",
            class: "space-y-2 border-2 border-border-hi bg-surface-2 p-4",
            {body}
            div { class: "flex flex-wrap gap-2",
                {signal_button(
                    lang,
                    field_key,
                    "confirm",
                    "data-signal-confirm",
                    "border-2 border-neon-cyan px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-neon-cyan hover:bg-neon-cyan hover:text-bg disabled:opacity-60",
                    "✓",
                    t(lang, "checkin.confirm"),
                    is_busy,
                    signals,
                    signal_error,
                    busy,
                    kiosk_id.clone(),
                    coords,
                )}
                {signal_button(
                    lang,
                    field_key,
                    "dispute",
                    "data-signal-dispute",
                    "border-2 border-border-hi px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-fg-muted hover:border-danger hover:text-danger disabled:opacity-60",
                    "✕",
                    t(lang, "checkin.dispute"),
                    is_busy,
                    signals,
                    signal_error,
                    busy,
                    kiosk_id,
                    coords,
                )}
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn signal_button(
    lang: Lang,
    field_key: &'static str,
    action: &'static str,
    marker: &'static str,
    class: &'static str,
    glyph: &'static str,
    label: String,
    disabled: bool,
    signals: &mut Signal<HashMap<String, (String, bool)>>,
    signal_error: &mut Signal<HashMap<String, String>>,
    busy: &mut Signal<String>,
    kiosk_id: String,
    coords: Signal<Option<crate::islands::Coords>>,
) -> Element {
    let onclick = {
        let signals = *signals;
        let signal_error = *signal_error;
        let busy = *busy;
        let kiosk_id = kiosk_id.clone();
        move |_| {
            spawn(post_signal(
                lang,
                field_key,
                action,
                kiosk_id.clone(),
                coords,
                signals,
                signal_error,
                busy,
            ));
        }
    };
    // rsx cannot express a dynamic attribute name, so the two markers get one
    // arm each; the button is otherwise identical.
    if marker == "data-signal-confirm" {
        rsx! {
            button {
                r#type: "button",
                "data-signal-confirm": "",
                "data-field-key": "{field_key}",
                class: "inline-flex cursor-pointer items-center gap-2 {class}",
                disabled: disabled,
                onclick: onclick,
                span { aria_hidden: "true", "{glyph}" }
                "{label}"
            }
        }
    } else {
        rsx! {
            button {
                r#type: "button",
                "data-signal-dispute": "",
                "data-field-key": "{field_key}",
                class: "inline-flex cursor-pointer items-center gap-2 {class}",
                disabled: disabled,
                onclick: onclick,
                span { aria_hidden: "true", "{glyph}" }
                "{label}"
            }
        }
    }
}

/// POST `/api/signals` and record the outcome.
async fn post_signal(
    lang: Lang,
    field_key: &'static str,
    action: &'static str,
    kiosk_id: String,
    coords: Signal<Option<crate::islands::Coords>>,
    mut signals: Signal<HashMap<String, (String, bool)>>,
    mut signal_error: Signal<HashMap<String, String>>,
    mut busy: Signal<String>,
) {
    busy.set(field_key.to_owned());
    let mut fields = vec![
        ("kiosk_id".to_string(), kiosk_id),
        ("field_key".to_string(), field_key.to_owned()),
        ("action".to_string(), action.to_owned()),
    ];
    if let Some(c) = *coords.peek() {
        fields.push(("lat".to_string(), c.lat.to_string()));
        fields.push(("lng".to_string(), c.lng.to_string()));
        fields.push(("accuracy".to_string(), c.accuracy.to_string()));
    }
    let Some(b) = browser() else {
        busy.set(String::new());
        return;
    };
    match b.0.post_form("/api/signals", fields).await {
        // Always-record: { verified, reason }. Verified rows get the loud
        // green confirmation, unverified land softer + amber (the engine sees
        // verified=0).
        Ok(res) if res.status < 300 => {
            let verified = res.body.is_empty()
                || serde_json::from_str::<serde_json::Value>(&res.body)
                    .ok()
                    .and_then(|v| v.get("verified").cloned())
                    .map(|v| v != serde_json::Value::Bool(false))
                    .unwrap_or(true);
            signal_error.write().remove(field_key);
            signals
                .write()
                .insert(field_key.to_owned(), (action.to_owned(), verified));
        }
        Ok(res) => {
            let msg = tpl(lang, "client.errServer", &[("status", &res.status)]);
            signal_error.write().insert(field_key.to_owned(), msg);
        }
        Err(_) => {
            signal_error
                .write()
                .insert(field_key.to_owned(), t(lang, "client.errNetwork"));
        }
    }
    busy.set(String::new());
}

/// `tone` softens the selected style for the neutral "Weiß nicht" option so a
/// formful of unanswered defaults doesn't read as a wall of pink.
fn tri_radio(
    name: &str,
    value: &str,
    label: String,
    checked: bool,
    neutral: bool,
    mut tri: Signal<HashMap<String, String>>,
) -> Element {
    let tone = if neutral {
        "has-checked:border-fg-dim has-checked:bg-surface-2 has-checked:text-fg"
    } else {
        "has-checked:border-neon-pink has-checked:bg-neon-pink has-checked:text-bg"
    };
    let name = name.to_owned();
    let value = value.to_owned();
    rsx! {
        label {
            class: format!(
                "inline-flex cursor-pointer select-none items-center gap-1 border-2 border-border bg-surface px-2 py-1 text-xs font-medium text-fg-dim transition-colors hover:border-border-hi hover:text-fg {tone}"
            ),
            input {
                r#type: "radio",
                name: "{name}",
                value: "{value}",
                checked: checked,
                class: "peer sr-only",
                onchange: {
                    let name = name.clone();
                    let value = value.clone();
                    move |_| {
                        tri.write().insert(name.clone(), value.clone());
                    }
                },
            }
            span { "{label}" }
        }
    }
}
