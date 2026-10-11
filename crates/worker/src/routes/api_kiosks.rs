//! Kiosk data APIs backed by the static asset
//! files.

use serde_json::{Map, Value, json};
use trinkhallen_core::filters::{apply_filters, parse_filter};
use trinkhallen_core::geo::{Bbox, parse_bbox, parse_lat_lng, quantize_bbox};
use trinkhallen_core::hours::{compute_status, kiosk_state};
use trinkhallen_core::navigate::{build_navigate_targets, js_num};
use trinkhallen_core::record::KioskRecord;
use worker::{Cache, Context, Env, Request, Response, Result};

use crate::assets;
use crate::http;
use crate::routes::{api_lang, build_panel, clamp, now, parse_int_js, query, user_agent};
use crate::state::RequestState;
use crate::util::query_get;

/// `GET /api/kiosks?bbox=west,south,east,north`
///
/// GeoJSON of the kiosks inside the bbox, cached in `caches.default` keyed by
/// a quantized bbox (~1 km grid) so adjacent pans hit cache. TTL is short
/// (60 s) — sync events invalidate by purging the cache namespace.
pub async fn collection(
    _req: Request,
    env: &Env,
    ctx: &Context,
    state: &RequestState,
) -> Result<Response> {
    let q = query(state);
    let Some(bbox) = parse_bbox(query_get(&q, "bbox")) else {
        return http::json(
            &json!({ "error": "bbox required as ?bbox=w,s,e,n" }).to_string(),
            400,
            &[],
        );
    };
    let limit = clamp(
        parse_int_js(query_get(&q, "limit").unwrap_or("5000")),
        1.0,
        10_000.0,
    ) as usize;
    let filter = parse_filter(|k| query_get(&q, k));
    let sig = filter.signature();

    let cache_key = cache_key_for(bbox, limit, &sig);
    // Filter signature changes invalidate; open_now changes minute-by-minute,
    // so we skip cache for it.
    let cacheable = !filter.open_now;
    let cache = Cache::default();
    if cacheable {
        if let Some(cached) = cache.get(&cache_key, false).await? {
            return Ok(cached);
        }
    }

    let set = assets::query_kiosks_in_bbox(env, bbox, limit).await?;
    let refs = set.refs();
    let filtered = apply_filters(&refs, &filter, now());
    let body = serde_json::to_string(&to_feature_collection(&filtered)).unwrap_or_default();
    let mut resp = http::response(
        "application/geo+json; charset=utf-8",
        body.into_bytes(),
        200,
        &[("cache-control", "public, max-age=60, s-maxage=60")],
    )?;
    if cacheable {
        let to_store = resp.cloned()?;
        let cache = Cache::default();
        // The cache write never delays the response.
        ctx.wait_until(async move {
            let _ = cache.put(cache_key, to_store).await;
        });
    }
    Ok(resp)
}

/// `GET /api/kiosks/panel` — the side-panel HTML fragment for the current
/// bbox + filters; the client swaps it into `#kiosk-panel`.
pub async fn panel(req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let lang = api_lang(&req, state);
    let q = query(state);
    let origin = parse_lat_lng(query_get(&q, "origin"));
    let ua = user_agent(&req);
    let Some(bbox) = parse_bbox(query_get(&q, "bbox")) else {
        let panel = build_panel(lang, &[], &parse_filter(|_| None), None, None, now(), false);
        return http::html(trinkhallen_ui::pages::panel::render(&panel), 200);
    };
    let filter = parse_filter(|k| query_get(&q, k));
    let set = assets::query_kiosks_in_bbox(env, bbox, 5000).await?;
    let refs = set.refs();
    let panel = build_panel(lang, &refs, &filter, origin, ua, now(), true);
    http::html(trinkhallen_ui::pages::panel::render(&panel), 200)
}

/// `GET /api/kiosks/nearest?origin=lat,lng` — closest kiosk with distance in
/// metres; the map's geolocate flow fitBounds around it.
pub async fn nearest(_req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let q = query(state);
    let Some(origin) = parse_lat_lng(query_get(&q, "origin")) else {
        return http::json(
            &json!({ "error": "origin lat,lng required" }).to_string(),
            400,
            &[],
        );
    };
    let Some((record, distance)) = assets::find_nearest_kiosk(env, origin).await? else {
        return http::json(
            &json!({ "error": "no kiosks in dataset" }).to_string(),
            404,
            &[],
        );
    };
    let body = json!({
        "id": record.id,
        "name": record.name,
        "lng": record.lng,
        "lat": record.lat,
        "distance": distance,
    })
    .to_string();
    http::json(
        &body,
        200,
        &[("cache-control", "public, max-age=30, s-maxage=30")],
    )
}

/// `GET /api/kiosks/nearest-open?origin=lat,lng` — closest currently-open
/// kiosk out of a generous candidate pool, with a UA-appropriate navigation
/// URL. Used by the `/jetzt` shortcut to deep-link into a native Maps app.
pub async fn nearest_open(req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let q = query(state);
    let Some(origin) = parse_lat_lng(query_get(&q, "origin")) else {
        return http::json(
            &json!({ "error": "origin lat,lng required" }).to_string(),
            400,
            &[],
        );
    };

    // Open-now is sparse on holidays and at night, so we'd rather walk a bit
    // farther than miss the only open Späti.
    let candidates = assets::find_nearby_kiosks(env, origin, "", 50).await?;
    let at = now();
    let mut hit: Option<(&KioskRecord, f64)> = None;
    for i in 0..candidates.len() {
        let (record, distance) = (candidates.record(i), candidates.distance(i));
        if compute_status(record.hours.as_ref(), at, kiosk_state(record)).is_open() {
            hit = Some((record, distance));
            break;
        }
    }
    let Some((record, distance)) = hit else {
        return http::json(
            &json!({ "error": "no open kiosks within reach" }).to_string(),
            404,
            &[],
        );
    };

    let nav = build_navigate_targets(
        &record.name,
        record.lat,
        record.lng,
        user_agent(&req).as_deref(),
    );
    let body = json!({
        "id": record.id,
        "name": record.name,
        "lng": record.lng,
        "lat": record.lat,
        "distance": distance,
        "nav_url": nav.primary.href,
        "detail_url": format!("/k/{}", record.id),
    })
    .to_string();
    http::json(&body, 200, &[("cache-control", "private, max-age=30")])
}

/// `GET /api/kiosks/:id` — one feature (+ `aggregate: null`, kept for shape
/// compatibility with the client).
pub async fn by_id(env: &Env, _state: &RequestState, id: &str) -> Result<Response> {
    let Some(record) = assets::get_kiosk_by_id(env, id).await? else {
        return http::json(&json!({ "error": "not found" }).to_string(), 404, &[]);
    };
    let mut feature = to_feature(&record);
    feature.insert("aggregate".into(), Value::Null);
    http::json(&Value::Object(feature).to_string(), 200, &[])
}

/// The GeoJSON shape the map client consumes: `address` always, everything
/// else only when the record carries it.
fn to_feature(r: &KioskRecord) -> Map<String, Value> {
    let mut properties = Map::new();
    properties.insert("id".into(), r.id.clone().into());
    properties.insert("name".into(), r.name.clone().into());
    if let Some(d) = &r.description {
        properties.insert("description".into(), d.clone().into());
    }
    properties.insert(
        "address".into(),
        serde_json::to_value(&r.address).unwrap_or_default(),
    );
    if let Some(h) = &r.hours {
        properties.insert("hours".into(), serde_json::to_value(h).unwrap_or_default());
    }
    properties.insert(
        "tags".into(),
        serde_json::to_value(&r.tags).unwrap_or_default(),
    );
    if let Some(p) = &r.payment {
        properties.insert(
            "payment".into(),
            serde_json::to_value(p).unwrap_or_default(),
        );
    }
    if let Some(s) = &r.sources {
        properties.insert(
            "sources".into(),
            serde_json::to_value(s).unwrap_or_default(),
        );
    }

    let mut geometry = Map::new();
    geometry.insert("type".into(), "Point".into());
    geometry.insert("coordinates".into(), json!([r.lng, r.lat]));

    let mut feature = Map::new();
    feature.insert("type".into(), "Feature".into());
    feature.insert("geometry".into(), Value::Object(geometry));
    feature.insert("properties".into(), Value::Object(properties));
    feature
}

fn to_feature_collection(records: &[&KioskRecord]) -> Value {
    json!({
        "type": "FeatureCollection",
        "features": records.iter().map(|r| Value::Object(to_feature(r))).collect::<Vec<_>>(),
    })
}

/// Cache key: quantized bbox (~1 km grid) + limit + filter signature. The
/// numbers render through [`js_num`] so keys stay byte-identical to existing cache entries
/// (including float artefacts like `50.300000000000004`).
pub fn cache_key_for(bbox: Bbox, limit: usize, sig: &str) -> String {
    let qb = quantize_bbox(bbox, 0.01);
    format!(
        "https://cache.trinkhallen.app/kiosks?b={},{},{},{}&l={limit}&f={sig}",
        js_num(qb.west),
        js_num(qb.south),
        js_num(qb.east),
        js_num(qb.north),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use trinkhallen_core::kind::KioskKind;

    #[test]
    fn cache_key_quantizes_the_bbox_like_js() {
        // JS: `b=${q(8.40123)},${q(50.11002)},${q(8.9)},${q(50.3)}` …
        let bbox = Bbox {
            west: 8.40123,
            south: 50.11002,
            east: 8.9,
            north: 50.3,
        };
        assert_eq!(
            cache_key_for(bbox, 5000, ""),
            "https://cache.trinkhallen.app/kiosks?b=8.4,50.11,8.9,50.300000000000004&l=5000&f="
        );
    }

    #[test]
    fn features_keep_the_ts_property_order() {
        let r = KioskRecord {
            id: "tk_fr_osm_1".into(),
            region: "frankfurt".into(),
            name: "Kiosk".into(),
            description: None,
            address: BTreeMap::new(),
            hours: None,
            tags: vec![],
            payment: None,
            lng: 8.68,
            lat: 50.11,
            sources: None,
            updated_at: 0,
            updated: None,
            kind: KioskKind::Kiosk,
        };
        let feature = Value::Object(to_feature(&r)).to_string();
        assert!(feature.starts_with(
            "{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[8.68,50.11]},\"properties\":{\"id\":\"tk_fr_osm_1\",\"name\":\"Kiosk\",\"address\":{},\"tags\":[]}}"
        ));
    }
}
