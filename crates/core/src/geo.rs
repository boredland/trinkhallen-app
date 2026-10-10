//! Bounding boxes, coordinates and distance.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

/// Great-circle distance in metres (haversine, IUGG mean Earth radius).
pub fn haversine_meters(a: LatLng, b: LatLng) -> f64 {
    const R: f64 = 6_371_008.8;
    let d_lat = (b.lat - a.lat).to_radians();
    let d_lng = (b.lng - a.lng).to_radians();
    let lat1 = a.lat.to_radians();
    let lat2 = b.lat.to_radians();
    let h = (d_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (d_lng / 2.0).sin().powi(2);
    2.0 * R * h.sqrt().asin()
}

/// "230 m", "1.2 km", "12 km".
pub fn format_distance(meters: f64) -> String {
    if !meters.is_finite() {
        return String::new();
    }
    if meters < 1000.0 {
        format!("{} m", meters.round() as i64)
    } else if meters < 10_000.0 {
        format!("{:.1} km", meters / 1000.0)
    } else {
        format!("{} km", (meters / 1000.0).round() as i64)
    }
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `"lat,lng"` → point, rejecting out-of-range values.
pub fn parse_lat_lng(raw: Option<&str>) -> Option<LatLng> {
    let raw = raw?;
    let mut parts = raw.split(',');
    let lat = parse_f64(parts.next()?)?;
    let lng = parse_f64(parts.next()?)?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return None;
    }
    Some(LatLng { lat, lng })
}

/// `"w,s,e,n"` → bbox; requires west < east and south < north.
pub fn parse_bbox(raw: Option<&str>) -> Option<Bbox> {
    let parts: Vec<f64> = raw?.split(',').map(parse_f64).collect::<Option<Vec<_>>>()?;
    let [west, south, east, north] = <[f64; 4]>::try_from(parts).ok()?;
    if west < -180.0 || east > 180.0 || south < -90.0 || north > 90.0 {
        return None;
    }
    if west >= east || south >= north {
        return None;
    }
    Some(Bbox { west, south, east, north })
}

/// A small box around a point (≈5 km), seeding the side panel for a focused
/// kiosk or a `?c=lat,lng` deep link; mirrors the map's initial viewport.
pub fn bbox_around(p: LatLng) -> Bbox {
    Bbox { west: p.lng - 0.05, south: p.lat - 0.04, east: p.lng + 0.05, north: p.lat + 0.04 }
}

/// Round edges to a grid so adjacent pans share a cache key.
pub fn quantize_bbox(b: Bbox, step: f64) -> Bbox {
    let r = |n: f64| (n / step).round() * step;
    Bbox { west: r(b.west), south: r(b.south), east: r(b.east), north: r(b.north) }
}

pub fn bbox_overlaps(a: [f64; 4], b: Bbox) -> bool {
    !(a[2] < b.west || a[0] > b.east || a[3] < b.south || a[1] > b.north)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        assert_eq!(parse_lat_lng(Some("50.11,8.68")), Some(LatLng { lat: 50.11, lng: 8.68 }));
        assert_eq!(parse_lat_lng(Some("91,8")), None);
        assert_eq!(parse_lat_lng(Some("x,8")), None);
        assert!(parse_bbox(Some("8.6,50.1,8.7,50.15")).is_some());
        assert_eq!(parse_bbox(Some("8.7,50.1,8.6,50.15")), None);
        assert_eq!(parse_bbox(Some("8.6,50.1,8.7")), None);
    }

    #[test]
    fn distance_format() {
        assert_eq!(format_distance(229.6), "230 m");
        assert_eq!(format_distance(1234.0), "1.2 km");
        assert_eq!(format_distance(12_345.0), "12 km");
        let d = haversine_meters(LatLng { lat: 50.11, lng: 8.68 }, LatLng { lat: 52.52, lng: 13.405 });
        assert!((d - 423_000.0).abs() < 5_000.0, "{d}");
    }
}
