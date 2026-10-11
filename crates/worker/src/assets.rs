//! Server-side accessor for the static kiosk data (`/data/_manifest.json` +
//! `/data/<slug>.geojson`).
//!
//! Two layers keep this cheap: the module-scope cache lives for the isolate's
//! lifetime (cold-start fetches happen at most once per region), and
//! `env.ASSETS.fetch` hits the edge cache before the asset blob. Only the
//! derived `KioskRecord`s are cached per region — holding the raw GeoJSON too
//! doubled isolate memory for no benefit.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde::de::DeserializeOwned;
use trinkhallen_core::geo::{Bbox, LatLng, bbox_overlaps, haversine_meters};
use trinkhallen_core::kind::KioskKind;
use trinkhallen_core::record::{Manifest, RecordCollection};
use trinkhallen_core::{KioskRecord, regions::parse_prefix};
use worker::{Env, Result};

type RegionRecords = Vec<KioskRecord>;

#[derive(Default)]
struct Cache {
    manifest: Option<Rc<Manifest>>,
    prefix_to_slug: HashMap<String, String>,
    regions: HashMap<String, Rc<RegionRecords>>,
}

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache::default());
}

/// The host is irrelevant (Workers Assets matches on path only) but must be
/// absolute — and must be passed as a *string*, not a `Request`.
async fn fetch_json<T: DeserializeOwned>(env: &Env, path: &str) -> Result<T> {
    let assets = env.assets("ASSETS")?;
    let mut resp = assets
        .fetch(format!("https://assets.local{path}"), None)
        .await?;
    if resp.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "asset {path} → HTTP {}",
            resp.status_code()
        )));
    }
    let body = resp.text().await?;
    serde_json::from_str(&body).map_err(|e| worker::Error::RustError(format!("asset {path}: {e}")))
}

pub async fn load_manifest(env: &Env) -> Result<Rc<Manifest>> {
    if let Some(m) = CACHE.with(|c| c.borrow().manifest.clone()) {
        return Ok(m);
    }
    let manifest: Manifest = fetch_json(env, "/data/_manifest.json").await?;
    let manifest = Rc::new(manifest);
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.prefix_to_slug = manifest
            .regions
            .iter()
            .map(|r| (r.prefix.clone(), r.slug.clone()))
            .collect();
        c.manifest = Some(manifest.clone());
    });
    Ok(manifest)
}

async fn region_records(env: &Env, slug: &str) -> Result<Rc<RegionRecords>> {
    if let Some(rs) = CACHE.with(|c| c.borrow().regions.get(slug).cloned()) {
        return Ok(rs);
    }
    let collection: RecordCollection = fetch_json(env, &format!("/data/{slug}.geojson")).await?;
    let records: RegionRecords = collection.into_records(slug);
    let records = Rc::new(records);
    CACHE.with(|c| {
        c.borrow_mut()
            .regions
            .insert(slug.to_owned(), records.clone())
    });
    Ok(records)
}

/// `tk_<prefix>_<rest>` → the region that owns the feature (`regions::parse_prefix`
/// plus the manifest's prefix→slug map).
async fn region_slug_for_id(env: &Env, id: &str) -> Result<Option<String>> {
    let Some(prefix) = parse_prefix(id) else {
        return Ok(None);
    };
    load_manifest(env).await?;
    Ok(CACHE.with(|c| c.borrow().prefix_to_slug.get(prefix).cloned()))
}

/// Records of one region (any kind), or `None` when the manifest has no such
/// region. Returned as an `Rc` so callers can index into it without cloning.
pub async fn region_kiosks(env: &Env, slug: &str) -> Result<Option<Rc<RegionRecords>>> {
    let manifest = load_manifest(env).await?;
    if !manifest.regions.iter().any(|r| r.slug == slug) {
        return Ok(None);
    }
    region_records(env, slug).await.map(Some)
}

/// All non-vending kiosks in the named region (`/stadt/:slug`).
pub async fn kiosks_by_region(env: &Env, slug: &str) -> Result<Rc<RegionRecords>> {
    let records = match region_kiosks(env, slug).await? {
        Some(rs) => rs,
        None => Rc::new(RegionRecords::new()),
    };
    Ok(Rc::new(
        records
            .iter()
            .filter(|r| r.kind == KioskKind::Kiosk)
            .cloned()
            .collect(),
    ))
}

/// Vending machines stay addressable via `/k/:id` deep links but are dropped
/// from every collection view.
pub fn visible(r: &KioskRecord) -> bool {
    r.kind == KioskKind::Kiosk
}

pub async fn get_kiosk_by_id(env: &Env, id: &str) -> Result<Option<KioskRecord>> {
    let Some(slug) = region_slug_for_id(env, id).await? else {
        return Ok(None);
    };
    let records = region_records(env, &slug).await?;
    Ok(records.iter().find(|r| r.id == id).cloned())
}

/// A result set that keeps the region buffers it points at alive, so the
/// records can be borrowed without cloning them out of the cache.
pub struct KioskSet {
    regions: Vec<Rc<RegionRecords>>,
    /// (region slot, index in region, distance in metres — 0 for bbox queries)
    hits: Vec<(u16, u32, f64)>,
}

impl KioskSet {
    pub fn len(&self) -> usize {
        self.hits.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hits.is_empty()
    }

    pub fn record(&self, i: usize) -> &KioskRecord {
        let (r, k, _) = self.hits[i];
        &self.regions[r as usize][k as usize]
    }

    pub fn distance(&self, i: usize) -> f64 {
        self.hits[i].2
    }

    pub fn iter(&self) -> impl Iterator<Item = (&KioskRecord, f64)> + '_ {
        (0..self.hits.len()).map(move |i| (self.record(i), self.distance(i)))
    }

    pub fn refs(&self) -> Vec<&KioskRecord> {
        (0..self.hits.len()).map(|i| self.record(i)).collect()
    }

    pub fn records(&self) -> Vec<&KioskRecord> {
        self.refs()
    }
}

/// Manifest regions whose bbox may intersect `bbox` (cheap pre-filter before
/// fetching region files).
pub fn select_region_slugs(manifest: &Manifest, bbox: Bbox) -> Vec<String> {
    manifest
        .regions
        .iter()
        .filter(|r| bbox_overlaps(r.bbox, bbox))
        .map(|r| r.slug.clone())
        .collect()
}

/// Collect the (non-vending) records inside `bbox`, capped at `limit`.
/// `loaded` is the already-fetched region data for the candidate slugs.
pub fn collect_in_bbox(loaded: &[Rc<RegionRecords>], bbox: Bbox, limit: usize) -> KioskSet {
    let mut set = KioskSet {
        regions: Vec::with_capacity(loaded.len()),
        hits: Vec::new(),
    };
    for records in loaded {
        let slot = set.regions.len() as u16;
        set.regions.push(records.clone());
        for (i, r) in records.iter().enumerate() {
            if !visible(r) {
                continue;
            }
            if r.lng >= bbox.west
                && r.lng <= bbox.east
                && r.lat >= bbox.south
                && r.lat <= bbox.north
            {
                set.hits.push((slot, i as u32, 0.0));
                if set.hits.len() >= limit {
                    return set;
                }
            }
        }
    }
    set
}

/// Kiosks inside `bbox` (default limit 5000).
pub async fn query_kiosks_in_bbox(env: &Env, bbox: Bbox, limit: usize) -> Result<KioskSet> {
    let manifest = load_manifest(env).await?;
    let slugs = select_region_slugs(&manifest, bbox);
    let mut loaded = Vec::with_capacity(slugs.len());
    for slug in &slugs {
        loaded.push(region_records(env, slug).await?);
    }
    Ok(collect_in_bbox(&loaded, bbox, limit))
}

/// Non-vending kiosks across every region — the `/about` figure. Prefers the
/// manifest's `visibleTotal` so one number serves the page without parsing
/// every region file.
pub async fn count_kiosks(env: &Env) -> Result<usize> {
    let manifest = load_manifest(env).await?;
    if let Some(total) = manifest.visible_total {
        return Ok(total);
    }
    let mut n = 0;
    for entry in &manifest.regions {
        let records = region_records(env, &entry.slug).await?;
        n += records.iter().filter(|r| visible(r)).count();
    }
    Ok(n)
}

/// Regions whose (padded) bbox contains `origin`, nearest first — only those
/// are loaded, and the search expands implicitly by padding ≈5 km.
fn candidate_slugs(manifest: &Manifest, origin: LatLng) -> Vec<String> {
    manifest
        .regions
        .iter()
        .filter(|r| {
            let [w, s, e, n] = r.bbox;
            w - 0.05 <= origin.lng
                && e + 0.05 >= origin.lng
                && s - 0.05 <= origin.lat
                && n + 0.05 >= origin.lat
        })
        .map(|r| r.slug.clone())
        .collect()
}

/// The `limit` closest kiosks to `origin`, excluding `exclude_id`.
pub async fn find_nearby_kiosks(
    env: &Env,
    origin: LatLng,
    exclude_id: &str,
    limit: usize,
) -> Result<KioskSet> {
    let manifest = load_manifest(env).await?;
    let mut loaded = Vec::new();
    for slug in candidate_slugs(&manifest, origin) {
        loaded.push(region_records(env, &slug).await?);
    }
    let mut set = KioskSet {
        regions: loaded,
        hits: Vec::new(),
    };
    for (slot, records) in set.regions.clone().iter().enumerate() {
        for (i, r) in records.iter().enumerate() {
            if !visible(r) || r.id == exclude_id {
                continue;
            }
            let d = haversine_meters(
                origin,
                LatLng {
                    lat: r.lat,
                    lng: r.lng,
                },
            );
            set.hits.push((slot as u16, i as u32, d));
        }
    }
    set.hits
        .sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
    set.hits.truncate(limit);
    Ok(set)
}

/// Lower bound on the distance from `origin` to anything inside `bbox`,
/// padded because the importer's region bboxes are rounded (features sit up
/// to ~1e-4° outside them) and shrunk because the clamped point is not quite
/// the closest one on a sphere.
fn min_distance_to_bbox(origin: LatLng, [w, s, e, n]: [f64; 4]) -> f64 {
    const PAD: f64 = 0.01;
    let clamped = LatLng {
        lat: origin.lat.clamp(s - PAD, n + PAD),
        lng: origin.lng.clamp(w - PAD, e + PAD),
    };
    haversine_meters(origin, clamped) * 0.9
}

/// Closest kiosk to `origin` across the whole dataset (never a vending
/// machine — an automat is never the recommendation). Regions are visited
/// nearest-bbox first and the scan stops once no remaining region can beat
/// the best hit, so a cold isolate parses one or two region files instead of
/// all of them.
pub async fn find_nearest_kiosk(env: &Env, origin: LatLng) -> Result<Option<(KioskRecord, f64)>> {
    let manifest = load_manifest(env).await?;
    let mut order: Vec<(f64, &str)> = manifest
        .regions
        .iter()
        .map(|r| (min_distance_to_bbox(origin, r.bbox), r.slug.as_str()))
        .collect();
    order.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut best: Option<(KioskRecord, f64)> = None;
    for (bound, slug) in order {
        if best.as_ref().is_some_and(|(_, bd)| *bd <= bound) {
            break;
        }
        let records = region_records(env, slug).await?;
        for r in records.iter().filter(|r| visible(r)) {
            let d = haversine_meters(
                origin,
                LatLng {
                    lat: r.lat,
                    lng: r.lng,
                },
            );
            if best.as_ref().is_none_or(|(_, bd)| d < *bd) {
                best = Some((r.clone(), d));
            }
        }
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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

    fn manifest() -> Manifest {
        Manifest {
            visible_total: Some(2),
            regions: vec![
                trinkhallen_core::record::ManifestEntry {
                    slug: "frankfurt".into(),
                    prefix: "fr".into(),
                    bbox: [8.4, 50.0, 8.9, 50.3],
                    count: 3,
                },
                trinkhallen_core::record::ManifestEntry {
                    slug: "koeln".into(),
                    prefix: "k".into(),
                    bbox: [6.6, 50.6, 7.7, 51.1],
                    count: 1,
                },
            ],
        }
    }

    #[test]
    fn bbox_query_selects_regions_and_records() {
        let bbox = Bbox {
            west: 8.4,
            south: 50.0,
            east: 8.9,
            north: 50.3,
        };
        assert_eq!(
            select_region_slugs(&manifest(), bbox),
            vec!["frankfurt".to_owned()]
        );

        let mut vending = rec("tk_fr_osm_v", "Automat", 8.6, 50.1);
        vending.kind = KioskKind::Vending;
        let region = Rc::new(vec![
            rec("tk_fr_osm_1", "Kiosk A", 8.5, 50.1),
            rec("tk_fr_osm_2", "Kiosk B", 9.5, 50.1), // outside the bbox
            vending,
        ]);
        let set = collect_in_bbox(&[region], bbox, 5000);
        assert_eq!(set.len(), 1);
        assert_eq!(set.record(0).id, "tk_fr_osm_1");
        assert_eq!(set.refs().len(), 1);
    }

    #[test]
    fn bbox_query_respects_the_limit() {
        let bbox = Bbox {
            west: 8.0,
            south: 50.0,
            east: 9.0,
            north: 50.3,
        };
        let region = Rc::new(vec![
            rec("tk_fr_osm_1", "A", 8.5, 50.1),
            rec("tk_fr_osm_2", "B", 8.55, 50.1),
            rec("tk_fr_osm_3", "C", 8.6, 50.1),
        ]);
        let set = collect_in_bbox(&[region], bbox, 2);
        assert_eq!(set.len(), 2);
        assert_eq!(set.record(1).id, "tk_fr_osm_2");
    }

    #[test]
    fn near_query_ranks_by_distance() {
        // Same geometry as `find_nearby_kiosks`, minus the asset fetch.
        let origin = LatLng {
            lat: 50.1,
            lng: 8.5,
        };
        let region = Rc::new(vec![
            rec("tk_fr_osm_1", "Near", 8.51, 50.1),
            rec("tk_fr_osm_2", "Far", 8.8, 50.1),
            rec("tk_fr_osm_3", "Self", 8.5, 50.1),
        ]);
        let mut set = KioskSet {
            regions: vec![region],
            hits: (0..3)
                .map(|i| {
                    (
                        0u16,
                        i,
                        haversine_meters(
                            origin,
                            LatLng {
                                lat: 50.1,
                                lng: 8.5 + 0.01 * i as f64,
                            },
                        ),
                    )
                })
                .collect(),
        };
        set.hits
            .retain(|(_, i, _)| set.regions[0][*i as usize].id != "tk_fr_osm_3");
        set.hits
            .sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
        set.hits.truncate(5);
        let ids: Vec<&str> = set.iter().map(|(r, _)| r.id.as_str()).collect();
        assert_eq!(ids, vec!["tk_fr_osm_1", "tk_fr_osm_2"]);
        assert!(set.distance(0) < set.distance(1));
    }
}
