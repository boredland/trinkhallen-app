//! The kiosk record views consume, and the GeoJSON shapes it is read from.
//!
//! Kiosk data is static: the importer bakes trinkhallen-data's per-region
//! FeatureCollections into `/data/<slug>.geojson`, and both the Worker and the
//! map client read those files. `Feature` mirrors that file format exactly so
//! a round trip through serde is lossless.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::kind::{KioskKind, classify_kind};

/// `raw` is the OSM `opening_hours` string; `week` is its build-time
/// flattening (see [`crate::hours`]), absent when the rule needs the full
/// evaluator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Hours {
    pub raw: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    #[serde(rename = "type")]
    pub ty: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
}

/// Tri-state payment flags as stored in the data repo (`"yes" | "no" | "unknown"`).
pub type Payment = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KioskRecord {
    pub id: String,
    /// Region slug (e.g. `frankfurt`, `hessen-rest`) — the data file it came from.
    pub region: String,
    pub name: String,
    pub description: Option<String>,
    pub address: BTreeMap<String, String>,
    pub hours: Option<Hours>,
    pub tags: Vec<String>,
    pub payment: Option<Payment>,
    pub lng: f64,
    pub lat: f64,
    pub sources: Option<Vec<Source>>,
    /// Unix seconds parsed from `properties.updated` (0 when absent).
    pub updated_at: i64,
    /// Present verbatim from `properties.updated` (YYYY-MM-DD) for display.
    pub updated: Option<String>,
    pub kind: KioskKind,
}

impl KioskRecord {
    pub fn addr(&self, key: &str) -> Option<&str> {
        self.address.get(key).map(String::as_str).filter(|s| !s.is_empty())
    }

    pub fn pays(&self, key: &str) -> Option<&str> {
        self.payment.as_ref()?.get(key).map(String::as_str)
    }

    pub fn hours_raw(&self) -> Option<&str> {
        self.hours.as_ref().map(|h| h.raw.as_str()).filter(|s| !s.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point {
    #[serde(rename = "type")]
    pub ty: String,
    pub coordinates: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct FeatureProps {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hours: Option<Hours>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment: Option<Payment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<Source>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// Anything else the data repo adds (enrichment metadata, OSM flags) is
    /// carried through untouched so re-serialised files stay byte-faithful in
    /// meaning.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Feature {
    #[serde(rename = "type")]
    pub ty: String,
    pub geometry: Point,
    pub properties: FeatureProps,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureCollection {
    #[serde(rename = "type")]
    pub ty: String,
    pub features: Vec<Feature>,
}

impl Feature {
    pub fn to_record(&self, region_slug: &str) -> KioskRecord {
        let p = &self.properties;
        let [lng, lat] = self.geometry.coordinates;
        let address = p
            .address
            .as_ref()
            .map(|a| {
                a.iter()
                    .filter_map(|(k, v)| match v {
                        serde_json::Value::String(s) => Some((k.clone(), s.clone())),
                        serde_json::Value::Number(n) => Some((k.clone(), n.to_string())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        KioskRecord {
            id: p.id.clone(),
            region: region_slug.to_owned(),
            name: p.name.clone(),
            description: p.description.clone().filter(|s| !s.is_empty()),
            address,
            hours: p.hours.clone().filter(|h| !h.raw.is_empty()),
            tags: p.tags.clone().unwrap_or_default(),
            payment: p.payment.clone(),
            lng,
            lat,
            sources: p.sources.clone(),
            updated_at: p.updated.as_deref().map(parse_ymd_seconds).unwrap_or(0),
            updated: p.updated.clone(),
            kind: classify_kind(Some(&p.name), p.kind.as_deref()),
        }
    }
}

/// `YYYY-MM-DD` (optionally followed by a time) → unix seconds at UTC midnight.
fn parse_ymd_seconds(s: &str) -> i64 {
    let day = s.get(..10).unwrap_or(s);
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| dt.and_utc().timestamp())
        .unwrap_or(0)
}

/// One entry of `/data/_manifest.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub slug: String,
    pub prefix: String,
    pub bbox: [f64; 4],
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    /// Non-vending kiosks across all regions, so `/about` never has to parse
    /// every region file to show one number.
    #[serde(default, rename = "visibleTotal", skip_serializing_if = "Option::is_none")]
    pub visible_total: Option<usize>,
    pub regions: Vec<ManifestEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_round_trips_and_maps_to_record() {
        let json = r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[8.68,50.11]},
          "properties":{"id":"tk_fr_1","name":"Wasserhäuschen","address":{"street":"Weg","number":"1"},
          "hours":{"raw":"Mo-Fr 08:00-20:00","week":[480,1200]},"tags":["wc"],"payment":{"cash":"yes"},
          "updated":"2026-05-01","osm_removed":false}}"#;
        let f: Feature = serde_json::from_str(json).unwrap();
        assert_eq!(f.properties.extra.get("osm_removed"), Some(&serde_json::Value::Bool(false)));
        let r = f.to_record("frankfurt");
        assert_eq!(r.region, "frankfurt");
        assert_eq!(r.addr("street"), Some("Weg"));
        assert_eq!(r.hours.as_ref().unwrap().week.as_deref(), Some(&[480, 1200][..]));
        assert_eq!(r.updated_at, 1777593600);
        assert_eq!(r.kind, KioskKind::Kiosk);
        let back = serde_json::to_value(&f).unwrap();
        assert_eq!(back["properties"]["osm_removed"], serde_json::Value::Bool(false));
    }
}
