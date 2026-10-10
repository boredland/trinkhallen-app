//! Query-string ⇄ structured filter, and filter application.
//!
//! Text search reproduces the Fuse.js 7.3 configuration the TS app used
//! (Bitap with `threshold 0.35`, `ignoreLocation`, `minMatchCharLength 2`,
//! weighted keys, field-length norm), so search results and their order stay
//! the same across the port — on the server panel and in the map client.

use chrono::{DateTime, Utc};

use crate::hours::{compute_status, state_from_week, week_minute};
use crate::record::KioskRecord;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Payment {
    pub cards: bool,
    pub contactless: bool,
    pub cash: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct KioskFilter {
    pub tags: Vec<String>,
    pub payment: Payment,
    pub open_now: bool,
    /// Kiosks missing opening hours — surfaces gaps for users to fill.
    pub needs_hours: bool,
    pub q: Option<String>,
}

impl KioskFilter {
    pub fn is_active(&self) -> bool {
        !self.tags.is_empty()
            || self.payment.cards
            || self.payment.contactless
            || self.payment.cash
            || self.open_now
            || self.needs_hours
            || self.q.is_some()
    }

    /// Stable cache-key suffix; empty filter → empty string.
    pub fn signature(&self) -> String {
        let mut parts = Vec::new();
        if !self.tags.is_empty() {
            let mut t = self.tags.clone();
            t.sort();
            parts.push(format!("t={}", t.join(",")));
        }
        if self.payment.cards {
            parts.push("p=cards".into());
        }
        if self.payment.contactless {
            parts.push("p=contactless".into());
        }
        if self.payment.cash {
            parts.push("p=cash".into());
        }
        if self.open_now {
            parts.push("o=1".into());
        }
        if self.needs_hours {
            parts.push("nh=1".into());
        }
        if let Some(q) = &self.q {
            parts.push(format!("q={}", q.to_lowercase()));
        }
        parts.join("&")
    }

    /// `pay=cards,cash&tags=wc` CSV form used in links and the filter form.
    pub fn pay_csv(&self) -> String {
        let mut v = Vec::new();
        if self.payment.cards {
            v.push("cards");
        }
        if self.payment.contactless {
            v.push("contactless");
        }
        if self.payment.cash {
            v.push("cash");
        }
        v.join(",")
    }
}

fn split_csv(raw: Option<&str>) -> Vec<String> {
    raw.map(|r| {
        r.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// `get` returns the first value of a query parameter.
pub fn parse_filter<'a>(get: impl Fn(&str) -> Option<&'a str>) -> KioskFilter {
    let pay: Vec<String> = split_csv(get("pay"));
    let flag = |k: &str| matches!(get(k), Some("1") | Some("true"));
    KioskFilter {
        tags: split_csv(get("tags"))
            .into_iter()
            .map(|t| t.to_lowercase())
            .collect(),
        payment: Payment {
            cards: pay.iter().any(|p| p == "cards"),
            contactless: pay.iter().any(|p| p == "contactless"),
            cash: pay.iter().any(|p| p == "cash"),
        },
        open_now: flag("open_now"),
        needs_hours: flag("needs_hours"),
        q: get("q")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    }
}

/// Fold common German ASCII spellings so "wirtshausl" finds "Würtshausl".
pub fn normalize_de(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        match c {
            'ä' => out.push_str("ae"),
            'ö' => out.push_str("oe"),
            'ü' => out.push_str("ue"),
            'ß' => out.push_str("ss"),
            '`' | '\'' => {}
            _ => out.push(c),
        }
    }
    out
}

/// Searchable view of a kiosk: the fields Fuse indexed, already normalized.
pub struct SearchDoc {
    pub name: String,
    pub description: String,
    pub street: String,
    pub city: String,
    pub district: String,
    pub tags: String,
}

impl SearchDoc {
    pub fn of(r: &KioskRecord) -> Self {
        SearchDoc {
            name: normalize_de(&r.name),
            description: normalize_de(r.description.as_deref().unwrap_or("")),
            street: normalize_de(r.addr("street").unwrap_or("")),
            city: normalize_de(r.addr("city").unwrap_or("")),
            district: normalize_de(r.addr("district").unwrap_or("")),
            tags: r
                .tags
                .iter()
                .map(|t| normalize_de(t))
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    fn fields(&self) -> [&str; 6] {
        [
            &self.name,
            &self.description,
            &self.street,
            &self.city,
            &self.district,
            &self.tags,
        ]
    }
}

/// Key weights as configured (0.5/0.15/0.15/0.05/0.1/0.05), normalized to sum 1.
const WEIGHTS: [f64; 6] = [0.5, 0.15, 0.15, 0.05, 0.1, 0.05];

/// Fuse `minMatchCharLength` / `threshold` as configured.
const MIN_MATCH: usize = 2;
const THRESHOLD: f64 = 0.35;

/// Field-length norm, rounded to 3 decimals like Fuse's index.
fn field_norm(text: &str) -> f64 {
    let tokens = text.split(' ').filter(|t| !t.is_empty()).count().max(1);
    let n = 1.0 / (tokens as f64).powf(0.5);
    (n * 1000.0).round() / 1000.0
}

/// Fuse's Bitap `search` with `ignoreLocation: true`, over UTF-16 units.
/// Returns the match score, or `None` for no match.
fn bitap(text: &[u16], pattern: &[u16]) -> Option<f64> {
    let plen = pattern.len();
    if plen == 0 || plen > 32 {
        return None;
    }
    let tlen = text.len();
    let mut alphabet: std::collections::HashMap<u16, u32> = std::collections::HashMap::new();
    for (i, &c) in pattern.iter().enumerate() {
        *alphabet.entry(c).or_insert(0) |= 1 << (plen - i - 1);
    }
    let calc = |errors: usize| errors as f64 / plen as f64;
    let mut current_threshold = THRESHOLD;
    let mut match_mask = vec![false; tlen];

    // Exact occurrences first (score 0).
    let mut from = 0;
    while let Some(idx) = find_sub(text, pattern, from) {
        current_threshold = current_threshold.min(0.0);
        for k in 0..plen {
            match_mask[idx + k] = true;
        }
        from = idx + plen;
    }

    let mut best_location: i64 = -1;
    let mut final_score = 1.0f64;
    let mut last_bit_arr: Vec<u32> = Vec::new();
    let mut bin_max = plen + tlen;
    let mask: u32 = 1 << (plen - 1);
    for i in 0..plen {
        // ignoreLocation: proximity never counts, so the binary search below
        // settles on bin_max whenever this error level is within threshold.
        let mut bin_min = 0usize;
        let mut bin_mid = bin_max;
        while bin_min < bin_mid {
            if calc(i) <= current_threshold {
                bin_min = bin_mid;
            } else {
                bin_max = bin_mid;
            }
            bin_mid = (bin_max - bin_min) / 2 + bin_min;
        }
        bin_max = bin_mid;
        let mut start: i64 = (1i64).max(0 - bin_mid as i64 + 1);
        let finish = (bin_mid.min(tlen)) + plen;
        let mut bit_arr = vec![0u32; finish + 2];
        bit_arr[finish + 1] = (1u32 << i).wrapping_sub(1);
        let mut j = finish as i64;
        while j >= start {
            let ju = j as usize;
            let loc = ju - 1;
            let char_match = text
                .get(loc)
                .and_then(|c| alphabet.get(c))
                .copied()
                .unwrap_or(0);
            if loc < tlen {
                match_mask[loc] = char_match != 0;
            }
            bit_arr[ju] = ((bit_arr[ju + 1] << 1) | 1) & char_match;
            if i > 0 {
                let l1 = *last_bit_arr.get(ju + 1).unwrap_or(&0);
                let l0 = *last_bit_arr.get(ju).unwrap_or(&0);
                bit_arr[ju] |= ((l1 | l0) << 1) | 1 | l1;
            }
            if bit_arr[ju] & mask != 0 {
                final_score = calc(i);
                if final_score <= current_threshold {
                    current_threshold = final_score;
                    best_location = loc as i64;
                    if best_location <= 0 {
                        break;
                    }
                    start = (1i64).max(-best_location);
                }
            }
            j -= 1;
        }
        if calc(i + 1) > current_threshold {
            break;
        }
        last_bit_arr = bit_arr;
    }
    if best_location < 0 {
        return None;
    }
    // minMatchCharLength > 1 ⇒ require a run of ≥ MIN_MATCH matched chars.
    let mut run = 0;
    let mut has_run = false;
    for &m in &match_mask {
        if m {
            run += 1;
            if run >= MIN_MATCH {
                has_run = true;
                break;
            }
        } else {
            run = 0;
        }
    }
    if !has_run {
        return None;
    }
    Some(final_score.max(0.001))
}

fn find_sub(text: &[u16], pat: &[u16], from: usize) -> Option<usize> {
    if pat.len() > text.len() {
        return None;
    }
    (from..=text.len() - pat.len()).find(|&i| text[i..i + pat.len()] == *pat)
}

/// `BitapSearch.searchIn` for one field (exact equality short-circuits to 0).
fn search_in(text: &str, pattern16: &[u16], pattern: &str) -> Option<f64> {
    let lowered = text.to_lowercase();
    if lowered == pattern {
        return Some(0.0);
    }
    let t16: Vec<u16> = lowered.encode_utf16().collect();
    if pattern16.len() <= 32 {
        return bitap(&t16, pattern16);
    }
    // Long patterns: Fuse splits into 32-unit chunks and averages.
    let mut total = 0.0;
    let mut any = false;
    let mut chunks = Vec::new();
    let rem = pattern16.len() % 32;
    let mut i = 0;
    while i < pattern16.len() - rem {
        chunks.push(&pattern16[i..i + 32]);
        i += 32;
    }
    if rem > 0 {
        chunks.push(&pattern16[pattern16.len() - 32..]);
    }
    for c in &chunks {
        match bitap(&t16, c) {
            Some(s) => {
                any = true;
                total += s;
            }
            None => total += 1.0,
        }
    }
    any.then(|| total / chunks.len() as f64)
}

/// Fuzzy-rank `docs` against `query` like Fuse: returns indices of matching
/// docs, best first (ties keep input order).
pub fn fuzzy_search(docs: &[SearchDoc], query: &str) -> Vec<usize> {
    let pattern = normalize_de(query).to_lowercase();
    if pattern.is_empty() {
        return Vec::new();
    }
    let p16: Vec<u16> = pattern.encode_utf16().collect();
    let total: f64 = WEIGHTS.iter().sum();
    let mut scored: Vec<(f64, usize)> = Vec::new();
    for (idx, doc) in docs.iter().enumerate() {
        let mut score = 1.0f64;
        let mut matched = false;
        for (k, field) in doc.fields().iter().enumerate() {
            if field.trim().is_empty() {
                continue;
            }
            if let Some(s) = search_in(field, &p16, &pattern) {
                matched = true;
                let weight = WEIGHTS[k] / total;
                let base = if s == 0.0 { f64::EPSILON } else { s };
                score *= base.powf(weight * field_norm(field));
            }
        }
        if matched {
            scored.push((score, idx));
        }
    }
    scored.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    scored.into_iter().map(|(_, i)| i).collect()
}

/// Does a kiosk pass the structured (non-text) constraints?
pub fn matches_structured(r: &KioskRecord, f: &KioskFilter, now: DateTime<Utc>) -> bool {
    if !f.tags.is_empty() && !f.tags.iter().all(|t| r.tags.contains(t)) {
        return false;
    }
    // "Karte" = any card: Girocard dominates in Germany; credit cards and
    // contactless are the long tail, and old `pay=contactless` URLs map here.
    if (f.payment.cards || f.payment.contactless)
        && r.pays("cards") != Some("yes")
        && r.pays("contactless") != Some("yes")
        && r.pays("girocard") != Some("yes")
    {
        return false;
    }
    if f.payment.cash && r.pays("cash") != Some("yes") {
        return false;
    }
    if f.open_now {
        let open = match r.hours.as_ref().and_then(|h| h.week.as_ref()) {
            Some(week) if r.hours_raw().is_some() => state_from_week(week, week_minute(now)).open,
            _ => compute_status(r.hours.as_ref(), now, crate::hours::kiosk_state(r)).is_open(),
        };
        if !open {
            return false;
        }
    }
    if f.needs_hours && r.hours_raw().is_some() {
        return false;
    }
    true
}

/// Apply text search (shaping and ordering the candidate set) then structured filters.
pub fn apply_filters<'a>(
    records: &[&'a KioskRecord],
    f: &KioskFilter,
    now: DateTime<Utc>,
) -> Vec<&'a KioskRecord> {
    if !f.is_active() {
        return records.to_vec();
    }
    let candidates: Vec<&KioskRecord> = match &f.q {
        Some(q) => {
            let docs: Vec<SearchDoc> = records.iter().map(|r| SearchDoc::of(r)).collect();
            fuzzy_search(&docs, q)
                .into_iter()
                .map(|i| records[i])
                .collect()
        }
        None => records.to_vec(),
    };
    candidates
        .into_iter()
        .filter(|r| matches_structured(r, f, now))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn rec(name: &str, street: &str) -> KioskRecord {
        let mut address = BTreeMap::new();
        address.insert("street".into(), street.into());
        KioskRecord {
            id: name.into(),
            region: "frankfurt".into(),
            name: name.into(),
            description: None,
            address,
            hours: None,
            tags: vec![],
            payment: None,
            lng: 8.6,
            lat: 50.1,
            sources: None,
            updated_at: 0,
            updated: None,
            kind: crate::kind::KioskKind::Kiosk,
        }
    }

    #[test]
    fn parse_and_signature() {
        let q = [
            ("pay", "cards,cash"),
            ("tags", "WC,sonne"),
            ("open_now", "1"),
            ("q", "  bock "),
        ];
        let f = parse_filter(|k| q.iter().find(|(a, _)| *a == k).map(|(_, v)| *v));
        assert_eq!(f.tags, vec!["wc", "sonne"]);
        assert!(f.payment.cards && f.payment.cash && !f.payment.contactless);
        assert_eq!(f.q.as_deref(), Some("bock"));
        assert_eq!(f.signature(), "t=sonne,wc&p=cards&p=cash&o=1&q=bock");
        assert!(!parse_filter(|_| None).is_active());
    }

    #[test]
    fn normalizes_german() {
        assert_eq!(normalize_de("Würtshäusl's Straße"), "wuertshaeusls strasse");
    }

    #[test]
    fn fuzzy_finds_and_ranks() {
        let rs = [
            rec("Trinkhalle Bockenheim", "Leipziger Str."),
            rec("Kiosk am Markt", "Bockenheimer Landstraße"),
            rec("Wasserhäuschen Nordend", "Glauburgstraße"),
        ];
        let refs: Vec<&KioskRecord> = rs.iter().collect();
        let docs: Vec<SearchDoc> = refs.iter().map(|r| SearchDoc::of(r)).collect();
        let hits = fuzzy_search(&docs, "bockenheim");
        assert_eq!(
            hits.first(),
            Some(&0),
            "name match should outrank street match: {hits:?}"
        );
        assert!(hits.contains(&1));
        assert!(!hits.contains(&2));
        assert_eq!(fuzzy_search(&docs, "wasserhaeuschen"), vec![2]);
        assert_eq!(
            fuzzy_search(&docs, "wasserheuschen"),
            vec![2],
            "one typo still matches"
        );
        assert!(fuzzy_search(&docs, "zzzz").is_empty());
    }

    #[test]
    fn card_bucket_includes_girocard() {
        let mut r = rec("x", "y");
        r.payment = Some(
            [("girocard".to_string(), "yes".to_string())]
                .into_iter()
                .collect(),
        );
        let f = KioskFilter {
            payment: Payment {
                cards: true,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(matches_structured(&r, &f, Utc::now()));
        let f = KioskFilter {
            payment: Payment {
                cash: true,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(!matches_structured(&r, &f, Utc::now()));
    }
}
