//! `filters` island: the filter chip form and its live behaviour.
//!
//! Chip toggles rewrite the URL query (`buildFilterQuery` rules), dispatch
//! `tk:filters-changed` and refresh `#kiosk-panel` from its `data-panel-url`.
//! A 150 ms trailing debounce coalesces bursts (typing, multi-chip toggles),
//! so the map never hammers the server. Without JS the form still submits as a normal GET.

use dioxus::prelude::*;
use serde::{Deserialize, Serialize};
use trinkhallen_core::filters::KioskFilter;
use trinkhallen_core::i18n::{Lang, payment_label, t, tag_label};

use crate::islands::browser;

pub const NAME: &str = "filters";

/// The five query params the chips own. Everything else on the panel URL
/// (`lang`, `bbox`, `origin`) survives a filter change.
const OWNED_PARAMS: [&str; 5] = ["pay", "tags", "open_now", "needs_hours", "q"];

/// Chip-level filter state (the only state the form can express).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FilterState {
    pub open_now: bool,
    pub needs_hours: bool,
    /// The single "Karte" chip covers cards + contactless upstream.
    pub cards: bool,
    pub wc: bool,
    pub sitz: bool,
    pub q: String,
}

impl FilterState {
    pub fn from_filter(f: &KioskFilter) -> Self {
        FilterState {
            open_now: f.open_now,
            needs_hours: f.needs_hours,
            cards: f.payment.cards,
            wc: f.tags.iter().any(|t| t == "wc"),
            sitz: f.tags.iter().any(|t| t == "sitzgelegenheiten"),
            q: f.q.clone().unwrap_or_default(),
        }
    }

    /// `buildFilterQuery` output: `pay=cards&tags=wc&open_now=1&…`.
    pub fn query(&self) -> String {
        let mut parts: Vec<(String, String)> = Vec::new();
        if self.cards {
            parts.push(("pay".into(), "cards".into()));
        }
        let mut tags: Vec<&str> = Vec::new();
        if self.wc {
            tags.push("wc");
        }
        if self.sitz {
            tags.push("sitzgelegenheiten");
        }
        if !tags.is_empty() {
            parts.push(("tags".into(), tags.join(",")));
        }
        if self.open_now {
            parts.push(("open_now".into(), "1".into()));
        }
        if self.needs_hours {
            parts.push(("needs_hours".into(), "1".into()));
        }
        let q = self.q.trim();
        if !q.is_empty() {
            parts.push(("q".into(), q.to_owned()));
        }
        parts
            .into_iter()
            .map(|(k, v)| format!("{}={}", encode_form(&k), encode_form(&v)))
            .collect::<Vec<_>>()
            .join("&")
    }
}

#[derive(Props, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterProps {
    pub lang: Lang,
    pub state: FilterState,
    /// Where the GET fallback submits to.
    pub form_action: String,
    /// Hidden inputs preserved across submits (e.g. bbox).
    pub preserve: Vec<(String, String)>,
}

impl FilterProps {
    pub fn new(lang: Lang, filter: &KioskFilter, form_action: impl Into<String>) -> Self {
        FilterProps {
            lang,
            state: FilterState::from_filter(filter),
            form_action: form_action.into(),
            preserve: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn sample() -> Self {
        FilterProps::new(Lang::De, &KioskFilter::default(), "/")
    }
}

#[allow(non_snake_case)]
pub fn FilterIsland(props: FilterProps) -> Element {
    let mut state = use_signal(|| props.state.clone());
    // Bumped by every change; a scheduled submit only runs while its
    // generation is still current (the trailing-edge debounce).
    let generation = use_signal(|| 0u64);
    let lang = props.lang;

    let schedule = {
        let state = state;
        let generation = generation;
        move || {
            // Local mutable copies: the closure stays `Fn`, so every chip
            // handler can hold its own clone and call it.
            let mut generation = generation;
            let seq = {
                let mut g = generation.write();
                *g += 1;
                *g
            };
            let b = browser();
            spawn(async move {
                if let Some(b) = &b {
                    b.0.sleep_ms(150).await;
                }
                if *generation.peek() != seq {
                    return; // superseded by a newer change
                }
                let query = state.peek().query();
                submit(b.as_ref(), &query).await;
            });
        }
    };

    rsx! {
        form {
            action: "{props.form_action}",
            method: "get",
            class: "flex flex-wrap items-center gap-2",
            "data-filter-form": "",
            onsubmit: move |evt: FormEvent| {
                evt.prevent_default();
                schedule();
            },
            for (name, value) in &props.preserve {
                input { r#type: "hidden", name: "{name}", value: "{value}" }
            }

            {chip("open_now", "▶▶▶", t(lang, "filter.openNow"), state.read().open_now, {
                let mut state = state;
                let schedule = schedule.clone();
                move |on: bool| {
                    if on {
                        // "Offen jetzt" and "Zeiten fehlen" are mutually
                        // exclusive: one asks for kiosks that resolve to open
                        // right now, the other for kiosks with no hours at all.
                        state.write().needs_hours = false;
                    }
                    state.write().open_now = on;
                    schedule();
                }
            })}
            {chip("needs_hours", "❓", t(lang, "filter.needsHours"), state.read().needs_hours, {
                let mut state = state;
                let schedule = schedule.clone();
                move |on: bool| {
                    if on {
                        state.write().open_now = false;
                    }
                    state.write().needs_hours = on;
                    schedule();
                }
            })}
            {chip("pay_cards", "💳", payment_label(lang, "cards"), state.read().cards, {
                let mut state = state;
                let schedule = schedule.clone();
                move |on: bool| {
                    state.write().cards = on;
                    schedule();
                }
            })}
            {chip("tag_wc", "🚻", tag_label(lang, "wc"), state.read().wc, {
                let mut state = state;
                let schedule = schedule.clone();
                move |on: bool| {
                    state.write().wc = on;
                    schedule();
                }
            })}
            {chip("tag_sitzgelegenheiten", "🪑", t(lang, "filter.sitzen"), state.read().sitz, {
                let mut state = state;
                let schedule = schedule.clone();
                move |on: bool| {
                    state.write().sitz = on;
                    schedule();
                }
            })}

            // Search box collapses to icon on mobile via CSS-only :checked toggle
            label { class: "ml-auto flex items-center gap-1 border-2 border-border bg-surface px-2 py-1 text-sm",
                span { aria_hidden: "true", "🔎" }
                input {
                    r#type: "search",
                    name: "q",
                    placeholder: "{t(lang, \"filter.searchPlaceholder\")}",
                    value: "{state.read().q}",
                    class: "w-32 bg-transparent text-fg placeholder:text-fg-dim focus:outline-none",
                    oninput: move |evt| {
                        state.write().q = evt.value();
                        schedule();
                    },
                }
            }

            noscript {
                button { r#type: "submit", class: "btn-neon", "{t(lang, \"filter.apply\")}" }
            }
        }
    }
}

/// Style flows from the checkbox's live `:checked` state (via `:has()` on the
/// label, `peer-checked:` on the icon) — not from the SSR-time `checked` prop,
/// so a toggle updates the visual immediately.
fn chip(
    name: &'static str,
    icon: &'static str,
    label: String,
    checked: bool,
    on_toggle: impl FnMut(bool) + 'static,
) -> Element {
    let mut on_toggle = on_toggle;
    rsx! {
        label { class: "inline-flex cursor-pointer select-none items-center gap-1.5 border-2 border-border bg-transparent px-2 py-1 text-sm font-medium text-fg-dim transition-colors hover:border-border-hi hover:text-fg has-checked:border-neon-pink has-checked:bg-neon-pink has-checked:text-bg has-checked:shadow-[var(--shadow-glow-pink)]",
            input {
                r#type: "checkbox",
                name: "{name}",
                value: "1",
                checked,
                class: "peer sr-only",
                onchange: move |evt: FormEvent| on_toggle(evt.value() == "true"),
            }
            span {
                aria_hidden: "true",
                class: "opacity-50 grayscale transition peer-checked:opacity-100 peer-checked:grayscale-0",
                "{icon}"
            }
            span { "{label}" }
        }
    }
}

/// Replace the URL query, tell the map, and swap the side panel — the tail of
/// `attachFilterForm` (debounce already applied by the caller).
async fn submit(b: Option<&crate::islands::Browser>, query: &str) {
    let Some(b) = b else { return };
    let current = b.0.current_url();
    let path = current.split('?').next().unwrap_or("/");
    let url = if query.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{query}")
    };
    b.0.replace_url(&url);
    b.0.dispatch(
        "tk:filters-changed",
        &serde_json::Value::String(query.to_owned()).to_string(),
    );
    refresh_panel(b, query).await;
}

/// `refreshPanel`: GET `#kiosk-panel`'s `data-panel-url` with the filter params
/// merged in and swap the result into `#kiosk-panel`.
async fn refresh_panel(b: &crate::islands::Browser, query: &str) {
    let Some(base) = b.0.data_attr("kiosk-panel", "panel-url") else {
        return;
    };
    let url = merge_panel_url(&base, query);
    if let Ok(res) = b.0.get_text(&url).await {
        if res.status < 300 {
            b.0.set_inner_html("kiosk-panel", &res.body);
        }
    }
}

/// `URLSearchParams.set` for the five filter keys and `delete` for those the
/// new query does not carry — everything else on the panel URL is untouched
/// and keeps its position.
pub(crate) fn merge_panel_url(base: &str, query: &str) -> String {
    let new: Vec<(String, String)> = parse_query(query);
    let (prefix, qs) = match base.split_once('?') {
        Some((p, q)) => (p, q),
        None => (base, ""),
    };
    let mut out: Vec<String> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    for (k, v) in parse_query(qs) {
        if OWNED_PARAMS.contains(&k.as_str()) {
            if let Some((_, nv)) = new.iter().find(|(nk, _)| *nk == k) {
                out.push(format!("{}={}", encode_form(&k), encode_form(nv)));
                used.push(k.clone());
            }
            // else: dropped, as `URLSearchParams.delete` does.
        } else {
            out.push(format!("{}={}", encode_form(&k), encode_form(&v)));
        }
    }
    for (k, v) in &new {
        if !used.iter().any(|u| u == k) {
            out.push(format!("{}={}", encode_form(k), encode_form(v)));
        }
    }
    if out.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}?{}", out.join("&"))
    }
}

/// Split a query string into pairs, decoding `+`/percent escapes.
pub(crate) fn parse_query(qs: &str) -> Vec<(String, String)> {
    qs.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_form(k), decode_form(v))
        })
        .collect()
}

/// `application/x-www-form-urlencoded` writer (URLSearchParams's serializer).
pub(crate) fn encode_form(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn decode_form(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_matches_build_filter_query() {
        let mut s = FilterState {
            open_now: true,
            cards: true,
            wc: true,
            q: "  apfel  ".into(),
            ..Default::default()
        };
        assert_eq!(s.query(), "pay=cards&tags=wc&open_now=1&q=apfel");
        s.needs_hours = true;
        s.open_now = true; // both stay set if the UI allows it
        assert!(s.query().contains("needs_hours=1"));
        assert_eq!(FilterState::default().query(), "");
    }

    #[test]
    fn merge_keeps_foreign_params_in_place() {
        // Re-serializing goes through the urlencoded writer, which escapes
        // commas — same as `URLSearchParams#toString`.
        let base = "/api/kiosks/panel?lang=de&bbox=8.4,50.0,8.9,50.3&pay=cash&q=alt";
        let merged = merge_panel_url(base, "pay=cards&open_now=1");
        assert_eq!(
            merged,
            "/api/kiosks/panel?lang=de&bbox=8.4%2C50.0%2C8.9%2C50.3&pay=cards&open_now=1"
        );
        let cleared = merge_panel_url(base, "");
        assert_eq!(
            cleared,
            "/api/kiosks/panel?lang=de&bbox=8.4%2C50.0%2C8.9%2C50.3"
        );
    }

    #[test]
    fn form_encoding_round_trips() {
        assert_eq!(encode_form("a b&c"), "a+b%26c");
        assert_eq!(decode_form("a+b%26c"), "a b&c");
        assert_eq!(
            parse_query("q=sp%C3%A4ti"),
            vec![("q".to_string(), "späti".to_string())]
        );
    }

    #[test]
    fn state_follows_filter() {
        let f = KioskFilter {
            tags: vec!["wc".into()],
            open_now: true,
            ..Default::default()
        };
        let s = FilterState::from_filter(&f);
        assert!(s.wc && s.open_now && !s.cards);
    }
}
