//! Small shared helpers: env string bindings, randomness, and the
//! URL-encoding the language redirect needs.
//!
//! The query helpers deliberately mirror WHATWG `URLSearchParams`
//! including its
//! `application/x-www-form-urlencoded` serialisation, because `?setlang=`
//! redirects echo the remaining query back.

use chrono::Datelike;
use worker::Env;

/// Unix seconds — the unit every D1 timestamp column uses.
pub fn now() -> i64 {
    crate::crypto::unix_now()
}

/// Env string binding (var or secret) with missing/empty both counting as
/// "unset" — how every optional credential degrades.
pub fn env_str(env: &Env, name: &str) -> Option<String> {
    let value = env.get_binding::<worker::Secret>(name).ok()?.to_string();
    (!value.is_empty()).then_some(value)
}

/// `crypto.getRandomValues` through `getrandom`, biased like JS
/// `randomInt` (`buf[0] % max`) so generated handles keep their existing
/// distribution.
pub fn random_int(max: u32) -> u32 {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    u32::from_le_bytes(b) % max.max(1)
}

// ── URLSearchParams-compatible query handling ───────────────────────────────

/// `URLSearchParams` parsing: `&`-separated `key=value`, `+` → space, then a
/// lenient percent-decode (invalid escapes stay literal, as in the spec
/// algorithm the JS implementation is based on).
pub fn parse_query(raw: &str) -> Vec<(String, String)> {
    raw.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_plus(k), decode_plus(v))
        })
        .collect()
}

fn decode_plus(s: &str) -> String {
    percent_decode(&s.replace('+', " "), true)
}

/// Percent-decoding. Lenient mode keeps invalid sequences verbatim (query
/// strings); strict mode returns the input untouched when any escape or the
/// resulting UTF-8 is invalid (cookie values, matching browsers' tolerant jars).
pub fn percent_decode(s: &str, lenient: bool) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
            if !lenient {
                return s.to_owned();
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

pub fn query_get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

pub fn query_has(pairs: &[(String, String)], key: &str) -> bool {
    pairs.iter().any(|(k, _)| k == key)
}

/// `URLSearchParams.delete(key)` — drops every occurrence.
pub fn query_without(pairs: &[(String, String)], key: &str) -> Vec<(String, String)> {
    pairs.iter().filter(|(k, _)| k != key).cloned().collect()
}

/// `URLSearchParams.toString()`.
pub fn serialize_query(pairs: &[(String, String)]) -> String {
    let mut out = String::new();
    for (k, v) in pairs {
        if !out.is_empty() {
            out.push('&');
        }
        out.push_str(&form_urlencode(k));
        out.push('=');
        out.push_str(&form_urlencode(v));
    }
    out
}

/// `application/x-www-form-urlencoded` serialiser: space → `+`, `*-._` and
/// alphanumerics verbatim, everything else percent-encoded (uppercase hex).
fn form_urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b' ' => out.push('+'),
            b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `toLocaleDateString("de-DE")` for the operator mail's `DD.MM.YYYY`.
pub fn de_date(unix: i64) -> String {
    let (y, m, d) = match chrono::DateTime::from_timestamp(unix, 0) {
        Some(t) => (t.year(), t.month(), t.day()),
        None => return String::new(),
    };
    format!("{:02}.{:02}.{}", d, m, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_round_trip_matches_urlsearchparams() {
        // Ground truth from production: /impressum?setlang=en&a=1%202&b=x+y&a=3
        // redirects to /en/impressum?a=1+2&b=x+y&a=3.
        let pairs = parse_query("setlang=en&a=1%202&b=x+y&a=3");
        assert_eq!(query_get(&pairs, "setlang"), Some("en"));
        assert_eq!(query_get(&pairs, "a"), Some("1 2"));
        let rest = query_without(&pairs, "setlang");
        assert_eq!(serialize_query(&rest), "a=1+2&b=x+y&a=3");
    }

    #[test]
    fn query_flags_and_escapes() {
        let pairs = parse_query("partial");
        assert!(query_has(&pairs, "partial"));
        assert_eq!(query_get(&pairs, "partial"), Some(""));
        assert_eq!(query_get(&parse_query("a=%C3%A4"), "a"), Some("ä"));
        // Invalid escape stays literal (URLSearchParams is lenient).
        assert_eq!(query_get(&parse_query("a=1%2"), "a"), Some("1%2"));
    }

    #[test]
    fn percent_decode_strict() {
        assert_eq!(percent_decode("a%2Fb", false), "a/b");
        assert_eq!(percent_decode("100%", false), "100%");
        assert_eq!(percent_decode("no+plus", false), "no+plus");
    }

    #[test]
    fn de_date_formats() {
        assert_eq!(de_date(1_700_000_000), "14.11.2023");
    }
}
