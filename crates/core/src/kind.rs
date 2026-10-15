//! What sort of place a record is.
//!
//! The `shop=kiosk`/`shop=beverages` Overpass filter catches some OSM nodes
//! that are pure vending machines (JIMA, Sielaff, "Automaten-Kiosk"). The data
//! repo tags canonical cases with `properties.kind = "vending_machine"`; a
//! conservative name match covers the rest. Vending entries are hidden from
//! collection views (map, lists, nearest) but `/k/:id` deep links still load.
//! In Spain the data repo also imports chinos (`kind = "convenience"`) and
//! Chinese-run bars (`kind = "bar"`); those are listed like kiosks and only
//! labelled differently.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KioskKind {
    Kiosk,
    Vending,
    Chino,
    Bar,
}

impl KioskKind {
    /// Shown on the map and in lists; vending machines are not.
    pub fn is_listed(self) -> bool {
        self != KioskKind::Vending
    }

    /// i18n key for the noun in "X is {type} in {city}".
    pub fn noun_key(self) -> &'static str {
        match self {
            KioskKind::Chino => "kind.chino",
            KioskKind::Bar => "kind.bar",
            KioskKind::Kiosk | KioskKind::Vending => "kind.kiosk",
        }
    }

    /// i18n key for the short list/detail badge; plain kiosks get none.
    pub fn badge_key(self) -> Option<&'static str> {
        match self {
            KioskKind::Chino => Some("kind.badge.chino"),
            KioskKind::Bar => Some("kind.badge.bar"),
            KioskKind::Kiosk | KioskKind::Vending => None,
        }
    }
}

pub fn classify_kind(name: Option<&str>, data_kind: Option<&str>) -> KioskKind {
    match data_kind {
        Some("vending_machine") => return KioskKind::Vending,
        Some("convenience") => return KioskKind::Chino,
        Some("bar") => return KioskKind::Bar,
        _ => {}
    }
    let n = name.unwrap_or("").trim().to_lowercase();
    if n.is_empty() {
        return KioskKind::Kiosk;
    }
    let words: Vec<&str> = n
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has_word = |w: &str| words.contains(&w);
    // Equivalent to the original regexes: /^jima$/, /\bselecta\b/, /\bsielaff\b/,
    // /\bvending\s+machines?\b/, /\bautomaten[-\s]*kiosk\b/, /\bautomaten[-\s]*shop\b/.
    let vending = n == "jima"
        || has_word("selecta")
        || has_word("sielaff")
        || words
            .windows(2)
            .any(|w| w[0] == "vending" && (w[1] == "machine" || w[1] == "machines"))
        || automaten_compound(&n, "kiosk")
        || automaten_compound(&n, "shop");
    if vending {
        KioskKind::Vending
    } else {
        KioskKind::Kiosk
    }
}

/// `\bautomaten[-\s]*<tail>\b` — "automaten" at a word start, any run of
/// spaces/hyphens, then `tail` ending at a word boundary.
fn automaten_compound(n: &str, tail: &str) -> bool {
    let bytes = n.as_bytes();
    let mut search = 0;
    while let Some(off) = n[search..].find("automaten") {
        let start = search + off;
        let at_word_start = start == 0 || !is_word(bytes[start - 1]);
        let mut i = start + "automaten".len();
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'-' || bytes[i] == b'\t') {
            i += 1;
        }
        if at_word_start && n[i..].starts_with(tail) {
            let end = i + tail.len();
            if end == bytes.len() || !is_word(bytes[end]) {
                return true;
            }
        }
        search = start + 1;
    }
    false
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_kind_wins() {
        assert_eq!(
            classify_kind(Some("Kiosk"), Some("vending_machine")),
            KioskKind::Vending
        );
        assert_eq!(classify_kind(Some("Selecta"), Some("bar")), KioskKind::Bar);
        assert_eq!(
            classify_kind(Some("Alimentación"), Some("convenience")),
            KioskKind::Chino
        );
    }

    #[test]
    fn name_patterns() {
        for n in [
            "JIMA",
            "Selecta Snack",
            "Sielaff",
            "Vending Machines",
            "Automaten-Kiosk",
            "automaten shop 24",
        ] {
            assert_eq!(classify_kind(Some(n), None), KioskKind::Vending, "{n}");
        }
        for n in [
            "Jima Kiosk",
            "Kiosk am Automatenweg",
            "Wasserhäuschen",
            "",
            "Automatenkioskbetrieb",
        ] {
            assert_eq!(classify_kind(Some(n), None), KioskKind::Kiosk, "{n}");
        }
    }
}
