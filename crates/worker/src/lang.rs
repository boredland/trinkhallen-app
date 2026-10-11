//! First-visit language handling for page GETs, as a pure decision function.
//!
//! Two jobs:
//!   1. `?setlang=xx` — the header switcher's explicit choice: persist a sticky
//!      cookie and bounce to the clean URL in that locale.
//!   2. Auto-detect — when the visitor's preference (cookie, else
//!      Accept-Language) is a non-default language but they are on a
//!      default-locale URL, redirect to the prefixed equivalent.
//!
//! It only ever *upgrades* a default-locale path to a prefixed one — explicit
//! `/en` URLs and crawlers with no language signal are never bounced. Normal
//! renders set no cookie, so the HTML stays cacheable.
//!
//! `cookie` is the *value* of the `tk_lang` cookie,
//! not the raw header.

use trinkhallen_core::i18n::{DEFAULT_LANG, Lang, lang_from_path, path_for_lang, resolve_lang};

use crate::http::cookie_value;
use crate::util::{parse_query, query_get, query_has, query_without, serialize_query};

pub const LANG_COOKIE: &str = "tk_lang";
pub const LANG_COOKIE_MAX_AGE: u32 = 60 * 60 * 24 * 365;

/// What the middleware would do with this request.
#[derive(Debug, PartialEq)]
pub struct LangDecision {
    /// `Some(location)` → answer 302 with this target.
    pub location: Option<String>,
    /// `Set-Cookie` value to attach (explicit `setlang`, or the first-visit
    /// auto-detect when no language cookie exists yet).
    pub set_cookie: Option<String>,
    /// The language the request renders in when it is not redirected.
    pub lang: Lang,
}

pub fn lang_cookie(lang: Lang) -> String {
    cookie_value(
        LANG_COOKIE,
        lang.code(),
        LANG_COOKIE_MAX_AGE,
        "/",
        false,
        true,
        Some("lax"),
    )
}

/// `query` is the raw query string without the leading `?`, `path` the
/// request path (possibly `/en`-prefixed).
pub fn decide(
    path: &str,
    query: &str,
    cookie: Option<&str>,
    accept_language: Option<&str>,
) -> LangDecision {
    let pairs = parse_query(query);

    if let Some(setlang) = query_get(&pairs, "setlang") {
        let chosen = resolve_lang(Some(setlang));
        // URLSearchParams semantics: drop *every* `setlang`, re-serialise the
        // rest (`?a=1%202` becomes `?a=1+2`).
        let rest = query_without(&pairs, "setlang");
        let qs = if rest.is_empty() {
            String::new()
        } else {
            format!("?{}", serialize_query(&rest))
        };
        return LangDecision {
            location: Some(format!("{}{}", path_for_lang(path, chosen), qs)),
            set_cookie: Some(lang_cookie(chosen)),
            lang: chosen,
        };
    }

    // Sheet/panel partial fetches already target the right locale.
    if query_has(&pairs, "partial") {
        return LangDecision {
            location: None,
            set_cookie: None,
            lang: lang_from_path(path),
        };
    }

    let preferred = resolve_lang(cookie.or(accept_language));
    if lang_from_path(path) == DEFAULT_LANG && preferred != DEFAULT_LANG {
        // Only the auto-detect case sets the cookie, and only when the visitor
        // has no stored choice yet.
        let set_cookie = if cookie.is_none() {
            Some(lang_cookie(preferred))
        } else {
            None
        };
        let qs = if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        };
        return LangDecision {
            location: Some(format!("{}{}", path_for_lang(path, preferred), qs)),
            set_cookie,
            lang: preferred,
        };
    }

    LangDecision {
        location: None,
        set_cookie: None,
        lang: lang_from_path(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_first_visit_on_root_redirects() {
        let d = decide("/", "", None, Some("en-US,en;q=0.9"));
        assert_eq!(d.location.as_deref(), Some("/en"));
        assert_eq!(
            d.set_cookie.as_deref(),
            Some("tk_lang=en; Max-Age=31536000; Path=/; Secure; SameSite=Lax")
        );
    }

    #[test]
    fn german_first_visit_stays() {
        let d = decide("/impressum", "", None, Some("de-DE,de;q=0.9"));
        assert_eq!(d.location, None);
        assert_eq!(d.set_cookie, None);
    }

    #[test]
    fn explicit_prefixed_url_never_bounces() {
        let d = decide("/en/impressum", "", None, Some("de-DE,de;q=0.9"));
        assert_eq!(d.location, None);
    }

    #[test]
    fn crawler_without_language_signal_stays() {
        let d = decide("/impressum", "", None, None);
        assert_eq!(d.location, None);
    }

    #[test]
    fn cookie_wins_over_accept_language() {
        // The cookie *value* carries the choice.
        let d = decide("/", "", Some("en"), Some("de-DE"));
        assert_eq!(d.location.as_deref(), Some("/en"));
        // Cookie already carries the choice — nothing to persist.
        assert_eq!(d.set_cookie, None);

        let d = decide("/impressum", "", Some("de"), Some("en-US"));
        assert_eq!(d.location, None);
    }

    #[test]
    fn auto_redirect_preserves_the_raw_query() {
        let d = decide("/", "c=50.11,8.68&z=14", None, Some("en"));
        assert_eq!(d.location.as_deref(), Some("/en?c=50.11,8.68&z=14"));
        let d = decide("/", "a=1%202&b=x+y&c=%C3%A4", None, Some("en"));
        assert_eq!(d.location.as_deref(), Some("/en?a=1%202&b=x+y&c=%C3%A4"));
    }

    #[test]
    fn setlang_persists_and_bounces_to_the_clean_url() {
        let d = decide("/en", "setlang=de", None, None);
        assert_eq!(d.location.as_deref(), Some("/"));
        assert_eq!(
            d.set_cookie.as_deref(),
            Some("tk_lang=de; Max-Age=31536000; Path=/; Secure; SameSite=Lax")
        );

        let d = decide("/impressum", "setlang=en", None, None);
        assert_eq!(d.location.as_deref(), Some("/en/impressum"));
    }

    #[test]
    fn setlang_reserialises_the_remaining_query() {
        // Ground truth from production: 302 /en/impressum?a=1+2&b=x+y&a=3
        let d = decide("/impressum", "setlang=en&a=1%202&b=x+y&a=3", None, None);
        assert_eq!(d.location.as_deref(), Some("/en/impressum?a=1+2&b=x+y&a=3"));
        // Empty value resolves to the default language; duplicates drop entirely.
        let d = decide("/", "setlang=", None, None);
        assert_eq!(d.location.as_deref(), Some("/"));
        let d = decide("/impressum", "setlang=de&setlang=en", None, None);
        assert_eq!(d.location.as_deref(), Some("/impressum"));
    }

    #[test]
    fn partial_fetches_are_exempt() {
        let d = decide("/impressum", "partial=1", None, Some("en"));
        assert_eq!(d.location, None);
        let d = decide("/", "partial", None, Some("en"));
        assert_eq!(d.location, None);
    }

    #[test]
    fn unknown_default_locale_paths_still_upgrade() {
        let d = decide("/foo", "", None, Some("en"));
        assert_eq!(d.location.as_deref(), Some("/en/foo"));
    }
}
