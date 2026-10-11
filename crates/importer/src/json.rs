//! Order-preserving JSON value with `JSON.parse` / `JSON.stringify` semantics,
//! so region files re-serialise the way they were originally written.
//!
//! `serde_json::Value` is avoided on purpose: object order matters for diffable
//! output, and enabling `preserve_order` would be unified workspace-wide.

use std::fmt::{self, Write};

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// Every JSON number is a double, exactly as in JavaScript.
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        match self {
            Json::Obj(entries) => entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// `obj[key] = value`: replaces in place (keeping position) or appends.
    pub fn set(&mut self, key: &str, value: Json) {
        if let Json::Obj(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some((_, slot)) => *slot = value,
                None => entries.push((key.to_owned(), value)),
            }
        }
    }

    pub fn obj<const N: usize>(entries: [(&str, Json); N]) -> Json {
        Json::Obj(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    pub fn str(s: impl Into<String>) -> Json {
        Json::Str(s.into())
    }

    pub fn num(n: impl Into<f64>) -> Json {
        Json::Num(n.into())
    }

    /// `JSON.stringify(value)`.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    pub fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => write_number(*n, out),
            Json::Str(s) => write_string(s, out),
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(entries) => {
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    // Rust's `{:?}` is not JSON; serde_json's escaper matches JSON.stringify
    // (quotes, backslash, \b\f\n\r\t, other controls as lowercase \u00xx).
    // Serialising a &str cannot fail.
    out.push_str(&serde_json::to_string(s).unwrap_or_default());
}

/// Shortest round-trip decimal digits of a positive finite double plus the
/// decimal exponent of the first digit, as V8 prints them.
///
/// Rust and V8 both find the shortest digit string, but when the double sits
/// exactly halfway between two such strings (`8.7512969970703125`) Rust rounds
/// up and V8 keeps the even digit. Region coordinates hit this, so the tie is
/// resolved here to match the JS output byte for byte.
fn shortest_digits(n: f64) -> (String, i32) {
    let sci = format!("{n:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let last = digits.as_bytes()[digits.len() - 1] - b'0';
    if last % 2 == 1 {
        // Exact expansion with the shortest digits followed by `5000…` is a tie.
        let exact = format!("{:.*e}", digits.len() + 760, n);
        let exact_digits: String = exact
            .split_once('e')
            .map_or("", |(m, _)| m)
            .chars()
            .filter(|c| *c != '.')
            .collect();
        let tail = &exact_digits[digits.len()..];
        let floor = &exact_digits[..digits.len()];
        let is_tie = tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0');
        if is_tie && floor.as_bytes()[floor.len() - 1] % 2 == 0 && digits != floor {
            digits = floor.to_owned();
        }
    }
    (digits, exp)
}

/// `Number::prototype.toString` (ECMA-262 Number::toString): plain decimal for
/// 1e-6 ≤ |x| < 1e21, exponent form (`1e+21`, `1.5e-7`) outside; `-0` prints
/// `0`, non-finite prints `null` (as `JSON.stringify` does).
fn write_number(n: f64, out: &mut String) {
    if !n.is_finite() {
        out.push_str("null");
        return;
    }
    if n == 0.0 {
        out.push('0');
        return;
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        let _ = write!(out, "{}", n as i64);
        return;
    }
    if n < 0.0 {
        out.push('-');
    }
    let (digits, exp) = shortest_digits(n.abs());
    let k = digits.len() as i32;
    // Position of the decimal point relative to the digit string.
    let point = exp + 1;
    if k <= point && point <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (point - k) as usize));
    } else if 0 < point && point <= 21 {
        out.push_str(&digits[..point as usize]);
        out.push('.');
        out.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let _ = write!(out, "e{}{}", if exp < 0 { '-' } else { '+' }, exp.abs());
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Json;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }

            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Json, E> {
                Ok(Json::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Json, E> {
                Ok(Json::Num(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Json, E> {
                Ok(Json::Num(v as f64))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Json, E> {
                Ok(Json::Num(v))
            }
            fn visit_str<E>(self, v: &str) -> Result<Json, E> {
                Ok(Json::Str(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> Result<Json, E> {
                Ok(Json::Str(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(4096));
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Arr(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries: Vec<(String, Json)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Json>()? {
                    // Duplicate keys: last value wins, first position stays (JS object semantics).
                    match entries.iter_mut().find(|(ek, _)| *ek == k) {
                        Some((_, slot)) => *slot = v,
                        None => entries.push((k, v)),
                    }
                }
                Ok(Json::Obj(entries))
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &str) -> Json {
        serde_json::from_str(src).unwrap()
    }

    #[test]
    fn round_trip_keeps_key_order_and_prints_numbers_like_js() {
        let v = parse(r#"{"z":1,"a":[5.0,7.90,-0.0,1e3,0.5,0.00001],"m":{"k":"ü\n"}}"#);
        assert_eq!(
            v.stringify(),
            r#"{"z":1,"a":[5,7.9,0,1000,0.5,0.00001],"m":{"k":"ü\n"}}"#
        );
    }

    #[test]
    fn exponent_form_matches_js_outside_the_plain_range() {
        assert_eq!(
            parse("[1e-7,1.5e-7,1e21,1.5e22]").stringify(),
            "[1e-7,1.5e-7,1e+21,1.5e+22]"
        );
        assert_eq!(
            parse("[100000000000000000000]").stringify(),
            "[100000000000000000000]"
        );
    }

    #[test]
    fn duplicate_keys_keep_first_position_last_value() {
        assert_eq!(
            parse(r#"{"a":1,"b":2,"a":3}"#).stringify(),
            r#"{"a":3,"b":2}"#
        );
    }

    #[test]
    fn set_replaces_in_place_or_appends() {
        let mut v = parse(r#"{"raw":"x","tail":1}"#);
        v.set("tail", Json::num(2));
        v.set("week", Json::Arr(vec![Json::num(1)]));
        assert_eq!(v.stringify(), r#"{"raw":"x","tail":2,"week":[1]}"#);
    }
}

#[cfg(test)]
mod number_tests {
    use super::*;

    fn fmt(n: f64) -> String {
        let mut s = String::new();
        write_number(n, &mut s);
        s
    }

    #[test]
    fn halfway_doubles_keep_the_even_digit_like_v8() {
        // 8.7512969970703125 is exactly representable; V8 prints ...312, Rust's `{}` prints ...313.
        assert_eq!(fmt(8.751296997070312), "8.751296997070312");
        assert_eq!(fmt(-8.751296997070312), "-8.751296997070312");
    }

    #[test]
    fn matches_number_to_string_across_magnitudes() {
        assert_eq!(fmt(50.10867585982567), "50.10867585982567");
        assert_eq!(fmt(0.000001), "0.000001");
        assert_eq!(fmt(0.0000001), "1e-7");
        assert_eq!(fmt(123456789012345680000.0), "123456789012345680000");
        assert_eq!(fmt(1e21), "1e+21");
        assert_eq!(fmt(1.5e300), "1.5e+300");
        assert_eq!(fmt(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(fmt(-1234.5), "-1234.5");
        assert_eq!(fmt(10080.0), "10080");
    }
}
