//! Region table (generated from trinkhallen-data's `regions.yml`) and the
//! rules that map a coordinate or slug to a region.
//!
//! Moderation needs each region's data-file path to open a PR against the
//! right file; the asset manifest doesn't carry it, so the importer writes
//! [`generated`] on every build (committed so tests run without a data
//! checkout). Never hand-edit it — change `regions.yml`.

mod generated;

pub use generated::REGIONS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    City,
    Rest,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub slug: &'static str,
    /// Path relative to the data repo root, e.g. `data/de/hessen/frankfurt.geojson`.
    pub path: &'static str,
    /// ID prefix for minted feature ids (`fr` → `tk_fr_xxxx`).
    pub prefix: &'static str,
    /// `[west, south, east, north]`.
    pub bbox: [f64; 4],
    pub role: Role,
}

fn bbox_contains(r: &Region, lng: f64, lat: f64) -> bool {
    let [w, s, e, n] = r.bbox;
    lng >= w && lng <= e && lat >= s && lat <= n
}

fn squared_anchor_distance(r: &Region, lng: f64, lat: f64) -> f64 {
    let [w, s, e, n] = r.bbox;
    let (c_lng, c_lat) = ((w + e) / 2.0, (s + n) / 2.0);
    let d_lng = (lng - c_lng) * lat.to_radians().cos();
    let d_lat = lat - c_lat;
    d_lng * d_lng + d_lat * d_lat
}

/// The region that owns a coordinate, using the data repo's `ownsFeature`
/// rule: city regions beat rest buckets, and among candidates the nearest
/// bbox centre wins. A submission must resolve exactly as the scraper would
/// file it, or it lands in a different file. `None` when no bbox contains the
/// point.
pub fn resolve_region_by_coords(lng: f64, lat: f64) -> Option<&'static Region> {
    let candidates: Vec<&Region> = REGIONS
        .iter()
        .filter(|r| bbox_contains(r, lng, lat))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let cities: Vec<&Region> = candidates
        .iter()
        .copied()
        .filter(|r| r.role == Role::City)
        .collect();
    let pool = if cities.is_empty() {
        candidates
    } else {
        cities
    };
    pool.into_iter().min_by(|a, b| {
        squared_anchor_distance(a, lng, lat)
            .partial_cmp(&squared_anchor_distance(b, lng, lat))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

pub fn resolve_region_by_slug(slug: &str) -> Option<&'static Region> {
    REGIONS.iter().find(|r| r.slug == slug)
}

pub fn resolve_region_by_path(path: &str) -> Option<&'static Region> {
    REGIONS.iter().find(|r| r.path == path)
}

pub fn resolve_region_by_prefix(prefix: &str) -> Option<&'static Region> {
    REGIONS.iter().find(|r| r.prefix == prefix)
}

/// ASCII Bundesland slug (third path segment of `data/de/<land>/…`) → the
/// full German state name used for public-holiday lookup.
const BUNDESLAND_BY_SLUG: [(&str, &str); 16] = [
    ("baden-wuerttemberg", "Baden-Württemberg"),
    ("bayern", "Bayern"),
    ("berlin", "Berlin"),
    ("brandenburg", "Brandenburg"),
    ("bremen", "Bremen"),
    ("hamburg", "Hamburg"),
    ("hessen", "Hessen"),
    ("mecklenburg-vorpommern", "Mecklenburg-Vorpommern"),
    ("niedersachsen", "Niedersachsen"),
    ("nordrhein-westfalen", "Nordrhein-Westfalen"),
    ("rheinland-pfalz", "Rheinland-Pfalz"),
    ("saarland", "Saarland"),
    ("sachsen", "Sachsen"),
    ("sachsen-anhalt", "Sachsen-Anhalt"),
    ("schleswig-holstein", "Schleswig-Holstein"),
    ("thueringen", "Thüringen"),
];

/// Full German state name for a region slug; `None` for non-German regions
/// (holidays there are evaluated without a calendar rather than a wrong one).
pub fn bundesland_for_region(region_slug: &str) -> Option<&'static str> {
    let region = resolve_region_by_slug(region_slug)?;
    let mut segs = region.path.split('/');
    let (_, country, land) = (segs.next()?, segs.next()?, segs.next()?);
    if country != "de" {
        return None;
    }
    BUNDESLAND_BY_SLUG
        .iter()
        .find(|(k, _)| *k == land)
        .map(|(_, v)| *v)
}

/// `tk_<prefix>_<rest>` → `<prefix>`; prefixes are `[a-z0-9]+`.
pub fn parse_prefix(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("tk_")?;
    let end = rest.find('_')?;
    let p = &rest[..end];
    (!p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_invariants() {
        let mut slugs = std::collections::HashSet::new();
        let mut prefixes = std::collections::HashSet::new();
        for r in REGIONS {
            assert!(slugs.insert(r.slug), "dup slug {}", r.slug);
            assert!(prefixes.insert(r.prefix), "dup prefix {}", r.prefix);
            assert!(
                r.prefix
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
                "{}",
                r.prefix
            );
            let [w, s, e, n] = r.bbox;
            assert!(
                w < e && s < n && w > 5.0 && e < 18.0 && s > 45.0 && n < 56.0,
                "{}",
                r.slug
            );
        }
        assert!(REGIONS.iter().any(|r| r.role == Role::Rest));
    }

    #[test]
    fn ownership_rule() {
        let slug = |lng, lat| resolve_region_by_coords(lng, lat).map(|r| r.slug);
        assert_eq!(slug(8.68, 50.11), Some("frankfurt"));
        // Inside both frankfurt and mainz bboxes: nearest anchor wins.
        assert_eq!(slug(8.24, 50.08), Some("mainz"));
        assert_eq!(slug(9.0, 50.8), Some("hessen-rest"));
        assert_eq!(slug(16.37, 48.21), Some("wien-rest"));
        assert_eq!(slug(8.54, 47.37), Some("schweiz-rest"));
        assert_eq!(slug(-30.0, 30.0), None);
    }

    #[test]
    fn bundesland() {
        assert_eq!(bundesland_for_region("frankfurt"), Some("Hessen"));
        assert_eq!(bundesland_for_region("hessen-rest"), Some("Hessen"));
        assert_eq!(bundesland_for_region("wien-rest"), None);
        assert_eq!(bundesland_for_region("atlantis"), None);
    }

    #[test]
    fn prefixes() {
        assert_eq!(parse_prefix("tk_fr_osm_n1"), Some("fr"));
        assert_eq!(parse_prefix("tk_at9r_x"), Some("at9r"));
        assert_eq!(parse_prefix("tk_fr-bw_x"), None);
        assert_eq!(parse_prefix("nope"), None);
    }
}
