//! Kiosk data for the map: the static `/data/*` files plus the filter logic.
//!
//! Filtering is `trinkhallen_core::filters`, so the map shows exactly what the
//! server panel lists:
//!
//!   - below [`DETAIL_ZOOM`]: one pre-baked supercluster snapshot per integer
//!     zoom band (`_summary_z5..z8.geojson`),
//!   - at/above it: the union of the per-region FeatureCollections whose bbox
//!     intersects the viewport, each fetched once per page load and then
//!     cached, minus pure vending machines.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use chrono::{TimeZone, Utc};
use serde_json::{Value, json};

use trinkhallen_core::filters::{KioskFilter, apply_filters, parse_filter};
use trinkhallen_core::record::{Feature, FeatureCollection, Manifest};

/// Zoom at which per-region detail data replaces the summaries.
pub const DETAIL_ZOOM: f64 = 9.0;
/// Integer zooms with a pre-baked summary snapshot. Kept in sync with
/// `SUMMARY_ZOOMS` in `crates/importer/src/data.rs`.
pub const SUMMARY_ZOOMS: [u32; 4] = [5, 6, 7, 8];

#[derive(Default)]
struct Store {
    manifest: Option<Manifest>,
    summaries: HashMap<u32, Value>,
    regions: HashMap<String, FeatureCollection>,
}

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store::default());
}

async fn load_manifest() -> Option<Manifest> {
    if let Some(m) = STORE.with(|s| s.borrow().manifest.clone()) {
        return Some(m);
    }
    let body = crate::net::get_text("/data/_manifest.json", "application/json")
        .await
        .ok()?;
    if !(200..300).contains(&body.status) {
        return None;
    }
    let m: Manifest = serde_json::from_str(&body.body).ok()?;
    STORE.with(|s| s.borrow_mut().manifest = Some(m.clone()));
    Some(m)
}

async fn load_summary(z: u32) -> Option<Value> {
    if let Some(v) = STORE.with(|s| s.borrow().summaries.get(&z).cloned()) {
        return Some(v);
    }
    let url = format!("/data/_summary_z{z}.geojson");
    let v = crate::net::get_json(&url).await?;
    STORE.with(|s| s.borrow_mut().summaries.insert(z, v.clone()));
    Some(v)
}

async fn load_region(slug: &str) -> Option<FeatureCollection> {
    if let Some(c) = STORE.with(|s| s.borrow().regions.get(slug).cloned()) {
        return Some(c);
    }
    let url = format!("/data/{slug}.geojson");
    let body = crate::net::get_text(&url, "application/geo+json")
        .await
        .ok()?;
    if !(200..300).contains(&body.status) {
        return None;
    }
    let c: FeatureCollection = serde_json::from_str(&body.body).ok()?;
    STORE.with(|s| s.borrow_mut().regions.insert(slug.to_owned(), c.clone()));
    Some(c)
}

fn bboxes_overlap(a: [f64; 4], b: [f64; 4]) -> bool {
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

/// Slugs whose region bbox intersects the viewport.
async fn regions_for_view(view: [f64; 4]) -> Vec<String> {
    let Some(m) = load_manifest().await else {
        return Vec::new();
    };
    m.regions
        .iter()
        .filter(|r| bboxes_overlap(r.bbox, view))
        .map(|r| r.slug.clone())
        .collect()
}

/// Feature collection for the `kiosks` source: every kiosk in view that the
/// current filter keeps, minus vending machines (deep links via `/k/:id` still
/// reach those, they just never surface on the map or sidebar).
pub async fn detail_features_for_view(view: [f64; 4], filter: &KioskFilter, now: i64) -> Value {
    let slugs = regions_for_view(view).await;
    if slugs.is_empty() {
        return empty_collection();
    }

    let mut owned: Vec<(String, Feature)> = Vec::new();
    for slug in &slugs {
        if let Some(c) = load_region(slug).await {
            owned.extend(c.features.into_iter().map(|f| (slug.clone(), f)));
        }
    }
    let now = Utc.timestamp_opt(now, 0).single().unwrap_or_else(Utc::now);
    filter_features(&owned, filter, now)
}

/// The map's feature set: vending machines dropped, then the same
/// `apply_filters` the server panel runs, so both always agree.
fn filter_features(
    owned: &[(String, Feature)],
    filter: &KioskFilter,
    now: chrono::DateTime<Utc>,
) -> Value {
    let records: Vec<trinkhallen_core::KioskRecord> =
        owned.iter().map(|(slug, f)| f.to_record(slug)).collect();
    let visible: Vec<usize> = (0..records.len())
        .filter(|&i| records[i].kind.is_listed())
        .collect();
    let refs: Vec<&trinkhallen_core::KioskRecord> = visible.iter().map(|&i| &records[i]).collect();
    let kept: HashSet<&str> = apply_filters(&refs, filter, now)
        .into_iter()
        .map(|r| r.id.as_str())
        .collect();

    let features: Vec<Value> = visible
        .into_iter()
        .filter(|&i| !filter.is_active() || kept.contains(records[i].id.as_str()))
        .map(|i| feature_json(&owned[i].1))
        .collect();
    json!({ "type": "FeatureCollection", "features": features })
}

/// One summary snapshot as served by the importer — passed through untouched.
pub async fn summary_for_zoom(z: u32) -> Value {
    load_summary(z).await.unwrap_or_else(empty_collection)
}

pub fn empty_collection() -> Value {
    json!({ "type": "FeatureCollection", "features": [] })
}

/// `Feature` → GeoJSON `Feature`, unchanged apart from serde's own key order:
/// the map renders whatever the data repo shipped.
fn feature_json(f: &Feature) -> Value {
    serde_json::to_value(f).unwrap_or_else(|_| json!({}))
}

/// The active summary band for a map zoom, `None` at/above [`DETAIL_ZOOM`].
pub fn active_summary_zoom(zoom: f64) -> Option<u32> {
    if zoom >= DETAIL_ZOOM {
        return None;
    }
    SUMMARY_ZOOMS
        .iter()
        .copied()
        .filter(|&z| zoom >= z as f64)
        .max()
}

/// The filter encoded in the current URL query — the same parser the panel
/// uses, so both lists always show the same kiosks.
pub fn filter_from_search(search: &str) -> KioskFilter {
    let mut params: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    crate::dom::for_each_query(search, |k, v| {
        params.entry(k.to_owned()).or_insert_with(|| v.to_owned());
    });
    parse_filter(|key| params.get(key).map(String::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinkhallen_core::filters::parse_filter;

    fn feature(
        id: &str,
        name: &str,
        kind: Option<&str>,
        tags: &[&str],
        cash: bool,
    ) -> (String, Feature) {
        let json = json!({
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [8.68, 50.11] },
            "properties": {
                "id": id, "name": name, "kind": kind, "tags": tags,
                "payment": { "cash": if cash { "yes" } else { "no" } }
            }
        });
        (
            "frankfurt".to_owned(),
            serde_json::from_value(json).expect("feature"),
        )
    }

    fn ids(v: &Value) -> Vec<String> {
        v["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["properties"]["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn now() -> chrono::DateTime<Utc> {
        Utc.timestamp_opt(1_700_000_000, 0).single().unwrap()
    }

    fn sample() -> Vec<(String, Feature)> {
        vec![
            feature("a", "Kiosk Eins", None, &["wc"], true),
            feature("b", "Wasserhäuschen", None, &[], false),
            feature("c", "Automat", Some("vending_machine"), &["wc"], true),
        ]
    }

    #[test]
    fn vending_machines_never_reach_the_map() {
        let out = filter_features(&sample(), &KioskFilter::default(), now());
        assert_eq!(ids(&out), ["a", "b"]);
    }

    #[test]
    fn structured_filter_matches_the_panel_filter() {
        let f = parse_filter(|k| match k {
            "tags" => Some("wc"),
            "pay" => Some("cash"),
            _ => None,
        });
        assert_eq!(ids(&filter_features(&sample(), &f, now())), ["a"]);
    }

    #[test]
    fn text_search_uses_the_shared_fuzzy_ranking() {
        let f = parse_filter(|k| (k == "q").then_some("wasserhaeuschen"));
        assert_eq!(ids(&filter_features(&sample(), &f, now())), ["b"]);
    }

    #[test]
    fn query_string_round_trips_through_the_shared_parser() {
        let f = parse_filter(|k| match k {
            "needs_hours" => Some("1"),
            "q" => Some("  kiosk "),
            _ => None,
        });
        assert!(f.needs_hours);
        assert_eq!(f.q.as_deref(), Some("kiosk"));
    }

    #[test]
    fn summary_band_follows_the_zoom() {
        assert_eq!(active_summary_zoom(5.0), Some(5));
        assert_eq!(active_summary_zoom(7.99), Some(7));
        assert_eq!(active_summary_zoom(8.5), Some(8));
        assert_eq!(active_summary_zoom(9.0), None);
    }

    #[test]
    fn bbox_overlap_is_inclusive_at_the_edges() {
        assert!(bboxes_overlap([0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 2.0, 2.0]));
        assert!(!bboxes_overlap([0.0, 0.0, 1.0, 1.0], [1.1, 1.1, 2.0, 2.0]));
    }
}
