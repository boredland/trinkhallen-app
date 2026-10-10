//! Two-language UI copy and locale-addressed URLs.
//!
//! The default language (German) lives at the root and every other supported
//! language gets a path prefix (`/en/...`). Missing English keys fall back to
//! German per key, then to the key itself, so English can lag without breaking
//! a page. Strings live in the generated [`catalog`] (from the TS catalog the
//! port started from) so copy is reviewed in one place.

mod catalog;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    #[default]
    De,
    En,
}

pub const DEFAULT_LANG: Lang = Lang::De;
pub const SUPPORTED_LANGS: [Lang; 2] = [Lang::De, Lang::En];
/// Languages other than the default get a URL path prefix.
pub const PREFIXED_LANGS: [Lang; 1] = [Lang::En];

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::De => "de",
            Lang::En => "en",
        }
    }

    /// BCP-47 locale for date/number formatting.
    pub fn intl_locale(self) -> &'static str {
        match self {
            Lang::De => "de-DE",
            Lang::En => "en-GB",
        }
    }

    /// `<meta property="og:locale">` value.
    pub fn og_locale(self) -> &'static str {
        match self {
            Lang::De => "de_DE",
            Lang::En => "en_GB",
        }
    }
}

/// Best-effort match of an Accept-Language header (or any candidate). Only the
/// first two characters are considered, matching the original behaviour.
pub fn resolve_lang(candidate: Option<&str>) -> Lang {
    let v: String = candidate.unwrap_or("").chars().take(2).collect::<String>().to_lowercase();
    match v.as_str() {
        "en" => Lang::En,
        _ => Lang::De,
    }
}

/// The language a request path encodes (`/en` prefix → En, else De).
pub fn lang_from_path(path: &str) -> Lang {
    for l in PREFIXED_LANGS {
        let p = format!("/{}", l.code());
        if path == p || path.starts_with(&format!("{p}/")) {
            return l;
        }
    }
    DEFAULT_LANG
}

/// Rewrite a path to a target language: strip any language prefix, then add
/// the target's (the default language has none). Always a leading-slash path.
pub fn path_for_lang(path: &str, target: Lang) -> String {
    let mut bare = path.to_owned();
    for l in PREFIXED_LANGS {
        let p = format!("/{}", l.code());
        if bare == p {
            bare = "/".into();
        } else if let Some(rest) = bare.strip_prefix(&format!("{p}/")) {
            bare = format!("/{rest}");
        }
    }
    if target == DEFAULT_LANG {
        return bare;
    }
    if bare == "/" { format!("/{}", target.code()) } else { format!("/{}{}", target.code(), bare) }
}

fn lookup(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn localized(
    lang: Lang,
    de: &'static [(&'static str, &'static str)],
    en: &'static [(&'static str, &'static str)],
    key: &str,
) -> Option<&'static str> {
    let primary = match lang {
        Lang::De => de,
        Lang::En => en,
    };
    lookup(primary, key).or_else(|| lookup(de, key))
}

/// Flat UI string. Unknown keys return the key (visible in review, never a panic).
pub fn t(lang: Lang, key: &str) -> String {
    localized(lang, catalog::MESSAGES_DE, catalog::MESSAGES_EN, key).unwrap_or(key).to_owned()
}

/// `&'static` variant of [`t`] for attribute positions; unknown keys yield "".
pub fn ts(lang: Lang, key: &str) -> &'static str {
    localized(lang, catalog::MESSAGES_DE, catalog::MESSAGES_EN, key).unwrap_or("")
}

/// Interpolated template: `{name}` placeholders replaced from `vars`;
/// placeholders without a value become empty.
pub fn tpl(lang: Lang, key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    let template = localized(lang, catalog::TEMPLATES_DE, catalog::TEMPLATES_EN, key).unwrap_or(key);
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if after[..close].chars().all(|c| c.is_alphanumeric() || c == '_') => {
                let name = &after[..close];
                if let Some((_, v)) = vars.iter().find(|(k, _)| *k == name) {
                    out.push_str(&v.to_string());
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn report_kind_label(lang: Lang, kind: &str) -> String {
    localized(lang, catalog::REPORT_KIND_DE, catalog::REPORT_KIND_EN, kind).unwrap_or(kind).to_owned()
}

/// `approved`/`pr_opened` deliberately collapse to one label — the PR
/// mechanism is not exposed to end users.
pub fn report_status_label(lang: Lang, status: &str) -> String {
    localized(lang, catalog::REPORT_STATUS_DE, catalog::REPORT_STATUS_EN, status)
        .unwrap_or(status)
        .to_owned()
}

pub fn status_pill_label(lang: Lang, status: &str) -> String {
    localized(lang, catalog::STATUS_PILL_DE, catalog::STATUS_PILL_EN, status)
        .unwrap_or(status)
        .to_owned()
}

pub fn payment_label(lang: Lang, key: &str) -> String {
    localized(lang, catalog::PAYMENT_DE, catalog::PAYMENT_EN, key).unwrap_or(key).to_owned()
}

/// Tag display label; slugs without an override fall back to title case.
pub fn tag_label(lang: Lang, slug: &str) -> String {
    localized(lang, catalog::TAG_DE, catalog::TAG_EN, slug).map(str::to_owned).unwrap_or_else(|| titlecase(slug))
}

pub fn tag_group_label(lang: Lang, key: &str) -> String {
    localized(lang, catalog::TAG_GROUP_DE, catalog::TAG_GROUP_EN, key).unwrap_or(key).to_owned()
}

fn titlecase(slug: &str) -> String {
    slug.replace('_', " ")
        .split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub struct OhLabels {
    pub unknown: &'static str,
    pub open: &'static str,
    pub closed: &'static str,
    pub closed_lower: &'static str,
    pub days: [&'static str; 7],
}

pub fn oh_labels(lang: Lang) -> &'static OhLabels {
    match lang {
        Lang::De => &catalog::OH_DE,
        Lang::En => &catalog::OH_EN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_paths() {
        assert_eq!(lang_from_path("/en"), Lang::En);
        assert_eq!(lang_from_path("/en/about"), Lang::En);
        assert_eq!(lang_from_path("/english"), Lang::De);
        assert_eq!(path_for_lang("/about", Lang::En), "/en/about");
        assert_eq!(path_for_lang("/", Lang::En), "/en");
        assert_eq!(path_for_lang("/en", Lang::De), "/");
        assert_eq!(path_for_lang("/en/k/x", Lang::De), "/k/x");
        assert_eq!(path_for_lang("/en/k/x", Lang::En), "/en/k/x");
    }

    #[test]
    fn resolve() {
        assert_eq!(resolve_lang(Some("en-US,en;q=0.9")), Lang::En);
        assert_eq!(resolve_lang(Some("de-DE")), Lang::De);
        assert_eq!(resolve_lang(None), Lang::De);
        assert_eq!(resolve_lang(Some("fr")), Lang::De);
    }

    #[test]
    fn messages_fall_back() {
        assert_eq!(t(Lang::De, "nav.map"), "Karte");
        assert_eq!(t(Lang::En, "nav.map"), "Map");
        assert_eq!(t(Lang::En, "no.such.key"), "no.such.key");
        assert_eq!(
            tpl(Lang::De, "kioskList.countAll", &[("n", &3), ("suffix", &"n")]),
            "3 Trinkhallen"
        );
        assert_eq!(tpl(Lang::De, "oh.openUntil", &[]), "Offen bis ");
        assert_eq!(tag_label(Lang::De, "snacks"), "Snacks");
        assert_eq!(tag_label(Lang::En, "wc"), "Toilet");
        assert_eq!(tag_label(Lang::En, "gemischte_tuete"), "Pick'n'mix");
        assert_eq!(report_status_label(Lang::De, "pr_opened"), "Akzeptiert");
    }
}
