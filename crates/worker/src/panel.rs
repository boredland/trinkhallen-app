//! Side-panel view shared by the map page and `GET /api/kiosks/panel`.
//!
//! The pipeline is: filter → sort →
//! count open-now over the *whole* filtered set → show the first 100.

use chrono::{DateTime, Utc};
use trinkhallen_core::filters::KioskFilter;
use trinkhallen_core::filters::apply_filters;
use trinkhallen_core::geo::{LatLng, haversine_meters};
use trinkhallen_core::hours::count_open_now;
use trinkhallen_core::record::KioskRecord;

/// Rows the panel renders, plus the counters in its header.
pub struct PanelView<'a> {
    /// Sorted, at most 100.
    pub kiosks: Vec<&'a KioskRecord>,
    /// Everything inside the bbox, before filtering.
    pub total_in_bbox: usize,
    /// Everything after filtering (before the 100-row cut).
    pub filtered_count: usize,
    pub open_now_count: usize,
}

/// `localeCompare(b, "de")` ordering, two levels:
///   - primary: diacritics fold to their base letters (`ä`→`a`, `ß`→`ss`),
///   - secondary: the plain lowercase spelling, so "Apfel" sorts before
///     "Äpfel" exactly like the German collation.
pub fn de_sort_key(name: &str) -> (String, String) {
    let lower = name.to_lowercase();
    let mut folded = String::with_capacity(lower.len());
    for c in lower.chars() {
        match c {
            'ä' => folded.push('a'),
            'ö' => folded.push('o'),
            'ü' => folded.push('u'),
            'ß' => folded.push_str("ss"),
            _ => folded.push(c),
        }
    }
    (folded, lower)
}

/// Build the panel for one bbox. `origin` sorts by distance ("in der Nähe"),
/// otherwise by name.
pub fn panel_view<'a>(
    all: &[&'a KioskRecord],
    filter: &KioskFilter,
    origin: Option<LatLng>,
    now: DateTime<Utc>,
) -> PanelView<'a> {
    let mut filtered = apply_filters(all, filter, now);
    if let Some(o) = origin {
        filtered.sort_by(|a, b| {
            let da = haversine_meters(
                o,
                LatLng {
                    lat: a.lat,
                    lng: a.lng,
                },
            );
            let db = haversine_meters(
                o,
                LatLng {
                    lat: b.lat,
                    lng: b.lng,
                },
            );
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        });
    } else {
        filtered.sort_by(|a, b| de_sort_key(&a.name).cmp(&de_sort_key(&b.name)));
    }
    let open_now_count = count_open_now(&filtered, now);
    PanelView {
        filtered_count: filtered.len(),
        total_in_bbox: all.len(),
        kiosks: filtered.into_iter().take(100).collect(),
        open_now_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use trinkhallen_core::kind::KioskKind;

    fn rec(id: &str, name: &str, lng: f64, lat: f64) -> KioskRecord {
        KioskRecord {
            id: id.into(),
            region: "frankfurt".into(),
            name: name.into(),
            description: None,
            address: BTreeMap::new(),
            hours: None,
            tags: vec![],
            payment: None,
            lng,
            lat,
            sources: None,
            updated_at: 0,
            updated: None,
            kind: KioskKind::Kiosk,
        }
    }

    fn names_in_panel(records: &[KioskRecord]) -> Vec<String> {
        let refs: Vec<&KioskRecord> = records.iter().collect();
        let view = panel_view(&refs, &KioskFilter::default(), None, Utc::now());
        view.kiosks.iter().map(|r| r.name.clone()).collect()
    }

    #[test]
    fn sorts_by_german_name_order() {
        // Ground truth: ["Äpfel","Apfel","Bäckerei"].sort((a,b)=>a.localeCompare(b,"de"))
        let records = [
            rec("1", "Äpfel", 8.5, 50.1),
            rec("2", "Apfel", 8.5, 50.1),
            rec("3", "Bäckerei", 8.5, 50.1),
        ];
        assert_eq!(names_in_panel(&records), vec!["Apfel", "Äpfel", "Bäckerei"]);
    }

    #[test]
    fn umlauts_follow_their_base_letters() {
        // Ground truth: ["Öl","Ost","Ohr","Ärger","Arbeit"].sort(…localeCompare…de)
        let records = [
            rec("1", "Öl", 8.5, 50.1),
            rec("2", "Ost", 8.5, 50.1),
            rec("3", "Ohr", 8.5, 50.1),
            rec("4", "Ärger", 8.5, 50.1),
            rec("5", "Arbeit", 8.5, 50.1),
        ];
        assert_eq!(
            names_in_panel(&records),
            vec!["Arbeit", "Ärger", "Ohr", "Öl", "Ost"]
        );
    }

    #[test]
    fn sorts_by_distance_when_origin_is_given() {
        let near = rec("1", "Zebra", 8.51, 50.1);
        let far = rec("2", "Alpha", 8.8, 50.1);
        let origin = LatLng {
            lat: 50.1,
            lng: 8.5,
        };
        let view = panel_view(
            &[&near, &far],
            &KioskFilter::default(),
            Some(origin),
            Utc::now(),
        );
        let ids: Vec<&str> = view.kiosks.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["1", "2"]);
    }

    #[test]
    fn counts_and_caps_match_the_ts_pipeline() {
        let now = Utc::now();
        let records: Vec<KioskRecord> = (0..120)
            .map(|i| {
                rec(
                    &format!("tk_fr_osm_{i}"),
                    &format!("Kiosk {i:03}"),
                    8.5,
                    50.1,
                )
            })
            .collect();
        let refs: Vec<&KioskRecord> = records.iter().collect();
        let view = panel_view(&refs, &KioskFilter::default(), None, now);
        assert_eq!(view.kiosks.len(), 100);
        assert_eq!(view.filtered_count, 120);
        assert_eq!(view.total_in_bbox, 120);
        assert_eq!(view.open_now_count, 0);
    }
}
