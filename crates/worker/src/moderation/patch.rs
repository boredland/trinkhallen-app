//! Structured data-file edits for approved reports and submissions — the
//! pure half of moderation (`applyReportPatch`,
//! `appendFeatureToCollection`).
//!
//! Everything here operates on `serde_json::Value` rather than the typed
//! `trinkhallen_core::record::FeatureCollection` on purpose: patches must
//! preserve properties the app does not know about (enrichment metadata,
//! OSM flags) and their key order, and must never re-order features the
//! data repo's scrape run left in a deliberate order.

use serde_json::{Map, Value};

use crate::crypto::unix_now;

/// Kinds `applyReportPatch` can turn into a structured data-file edit —
/// `trinkhallen_core::reports::KNOWN_PATCH_KINDS`.
pub const KNOWN_PATCH_KINDS: [&str; 7] = [
    "wrong_hours",
    "wrong_address",
    "wrong_name",
    "closed",
    "update_payment",
    "update_tags",
    "ph_open_observed",
];

fn parse_collection(text: &str) -> Result<Value, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    if doc.get("type").and_then(|v| v.as_str()) != Some("FeatureCollection")
        || doc.get("features").and_then(|v| v.as_array()).is_none()
    {
        return Err("target file is not a GeoJSON FeatureCollection".into());
    }
    Ok(doc)
}

fn serialize(doc: &Value) -> String {
    let mut out = serde_json::to_string_pretty(doc).unwrap_or_default();
    out.push('\n');
    out
}

fn feature_id(feature: &Value) -> Option<&str> {
    feature.pointer("/properties/id").and_then(|v| v.as_str())
}

/// Feature array of a collection already vetted by [`parse_collection`].
fn features(doc: &Value) -> &Vec<Value> {
    doc.get("features")
        .and_then(|v| v.as_array())
        .expect("collection checked in parse_collection")
}

fn features_mut(doc: &mut Value) -> &mut Vec<Value> {
    doc.get_mut("features")
        .and_then(|v| v.as_array_mut())
        .expect("collection checked in parse_collection")
}

/// Apply one structured report patch.
///
/// A known kind carrying no actionable data is a no-op: the file comes back
/// untouched so `propose_change` sees no diff and resolves the report
/// without opening a PR.
pub fn apply_report_patch(
    text: &str,
    kiosk_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<String, String> {
    if !KNOWN_PATCH_KINDS.contains(&kind) {
        return Err(format!("applyReportPatch: unsupported kind {kind}"));
    }
    let mut doc = parse_collection(text)?;
    let idx = features(&doc)
        .iter()
        .position(|f| feature_id(f) == Some(kiosk_id));
    let Some(idx) = idx else {
        return Err(format!("feature {kiosk_id} not found in file"));
    };

    // "Dauerhaft geschlossen" = the kiosk no longer exists: drop the feature.
    // A `closed: true` flag would fail the data repo's schema validation
    // (additionalProperties: false) and nothing reads it anyway — the kiosk
    // would keep showing up on the map.
    if kind == "closed" {
        features_mut(&mut doc).remove(idx);
        return Ok(serialize(&doc));
    }

    let mut props = feature_props(&doc, idx)?;
    let unchanged = match kind {
        "wrong_hours" => match payload.get("new_hours").and_then(|v| v.as_str()) {
            Some(raw) => {
                set_hours(&mut props, raw);
                false
            }
            None => true,
        },
        "wrong_address" => match payload.get("new_address").and_then(|v| v.as_object()) {
            Some(new_address) => {
                let mut current = props
                    .get("address")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                for (k, v) in new_address {
                    current.insert(k.clone(), v.clone());
                }
                props.insert("address".into(), Value::Object(current));
                false
            }
            None => true,
        },
        "wrong_name" => match payload.get("new_name").and_then(|v| v.as_str()) {
            Some(name) => {
                props.insert("name".into(), name.into());
                false
            }
            None => true,
        },
        "update_payment" => match payload.get("payment").and_then(|v| v.as_object()) {
            Some(payment) if !payment.is_empty() => {
                // Conservative: only fill missing keys; never overwrite an
                // existing value. Same policy as run-gmaps-payment.ts in the
                // data repo — we'd rather extend than argue with prior data.
                let mut current = props
                    .get("payment")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                for (k, v) in payment {
                    current.entry(k.clone()).or_insert_with(|| v.clone());
                }
                props.insert("payment".into(), Value::Object(current));
                false
            }
            _ => true,
        },
        "update_tags" => {
            let add = payload
                .get("add_tags")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let remove = payload
                .get("remove_tags")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if add.is_empty() && remove.is_empty() {
                true
            } else {
                let mut tags: Vec<String> = props
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|t| t.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                for tag in add.iter().filter_map(|t| t.as_str()) {
                    if !tags.iter().any(|t| t == tag) {
                        tags.push(tag.to_owned());
                    }
                }
                tags.retain(|t| !remove.iter().any(|r| r.as_str() == Some(t.as_str())));
                let values = tags.into_iter().map(Value::String).collect::<Vec<_>>();
                props.insert("tags".into(), Value::Array(values));
                false
            }
        }
        "ph_open_observed" => {
            // Auto-filed when someone checks in on a Bundesland public
            // holiday at a kiosk whose hours carry no PH rule. Append
            // `; PH open` rather than inheriting the weekday hours: a single
            // check-in only proves "open at some point during this PH", not
            // the full opening window.
            let current = props
                .get("hours")
                .and_then(|h| h.get("raw"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned();
            // Nothing actionable → no-op:
            //   - no hours to extend (lost its opening_hours since filing), or
            //   - a PH rule already exists — we won't override it (it may be a
            //     deliberate "PH off"); a moderator can edit the file by hand.
            if current.is_empty() || has_ph_rule(&current) {
                true
            } else {
                let trimmed = current.trim().trim_end_matches([';', ' ']);
                set_hours(&mut props, &format!("{trimmed}; PH open"));
                false
            }
        }
        _ => unreachable!("kind checked above"),
    };

    if unchanged {
        return Ok(text.to_owned());
    }
    props.insert("updated".into(), today().into());
    if let Some(map) = features_mut(&mut doc)
        .get_mut(idx)
        .and_then(|f| f.get_mut("properties"))
        .and_then(|v| v.as_object_mut())
    {
        *map = props;
    }
    Ok(serialize(&doc))
}

/// Append a feature to a collection, keeping the data repo's feature order:
/// non-OSM features first (user submissions live here), then OSM-only ones,
/// each block sorted by feature id the way `run-osm-scrape.ts` in the data repo writes files.
pub fn append_feature_to_collection(text: &str, feature: &Value) -> Result<String, String> {
    let mut doc = parse_collection(text)?;
    let new_osm = is_osm_only(feature);
    let new_id = feature_id(feature).unwrap_or_default();

    let mut insert_at = features(&doc).len();
    for (i, existing) in features(&doc).iter().enumerate() {
        let existing_osm = is_osm_only(existing);
        match (existing_osm as u8).cmp(&(new_osm as u8)) {
            std::cmp::Ordering::Greater => {
                insert_at = i;
                break;
            }
            std::cmp::Ordering::Less => continue,
            std::cmp::Ordering::Equal => {
                if locale_compare(new_id, feature_id(existing).unwrap_or_default()).is_lt() {
                    insert_at = i;
                    break;
                }
            }
        }
    }
    features_mut(&mut doc).insert(insert_at, feature.clone());
    Ok(serialize(&doc))
}

/// Whether every source on the feature is `osm` — `run-osm-scrape.ts`'s
/// `isOsmOnly` (data repo), the boundary between the two sorted blocks.
pub fn is_osm_only(feature: &Value) -> bool {
    let Some(sources) = feature
        .pointer("/properties/sources")
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    !sources.is_empty()
        && sources
            .iter()
            .all(|s| s.get("type").and_then(|v| v.as_str()) == Some("osm"))
}

/// ASCII approximation of `String.prototype.localeCompare` (the data repo's
/// `byId` comparator): case-insensitive primary key, then lowercase before
/// uppercase, then code units. Ids are minted with upper-case hex, so the
/// case tier is not hypothetical.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let fold = |s: &str| s.chars().flat_map(|c| c.to_lowercase()).collect::<String>();
    match fold(a).cmp(&fold(b)) {
        Ordering::Equal => {}
        other => return other,
    }
    // ICU tertiary: lowercase sorts before uppercase at the same position.
    let tier = |c: char| match c {
        c if c.is_lowercase() => 0u8,
        c if c.is_uppercase() => 1,
        _ => 2,
    };
    for (x, y) in a.chars().zip(b.chars()) {
        match tier(x).cmp(&tier(y)) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    a.cmp(b)
}

/// The PH rule test: an OSM `PH` token (word-boundary-ish,
/// so `SHOP` never matches), which is what `opening-hours` understands.
fn has_ph_rule(hours: &str) -> bool {
    let bytes = hours.as_bytes();
    for (i, _) in hours.match_indices("PH") {
        let before_ok = i == 0 || matches!(bytes[i - 1], b' ' | b',' | b';');
        let after = bytes.get(i + 2).copied();
        let after_ok = matches!(
            after,
            None | Some(b' ') | Some(b',') | Some(b';') | Some(b'\t')
        );
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

fn set_hours(props: &mut Map<String, Value>, raw: &str) {
    let mut hours = props
        .get("hours")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    hours.insert("raw".into(), raw.into());
    props.insert("hours".into(), Value::Object(hours));
}

/// A mutable copy of the feature's `properties` (the whole object, so
/// unknown keys survive untouched).
fn feature_props(doc: &Value, idx: usize) -> Result<Map<String, Value>, String> {
    features(doc)
        .get(idx)
        .and_then(|f| f.get("properties"))
        .and_then(|v| v.as_object())
        .cloned()
        .ok_or_else(|| format!("feature at index {idx} has no properties object"))
}

/// `YYYY-MM-DD` in UTC — `new Date().toISOString().slice(0, 10)`.
pub fn today() -> String {
    today_from(unix_now())
}

pub fn today_from(now: i64) -> String {
    let date = chrono::DateTime::from_timestamp(now, 0)
        .map(|dt| dt.date_naive())
        .unwrap_or_default();
    date.format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_doc(properties: serde_json::Value) -> String {
        serde_json::json!({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": { "type": "Point", "coordinates": [8.68, 50.11] },
                    "properties": properties,
                },
                {
                    "type": "Feature",
                    "geometry": { "type": "Point", "coordinates": [8.69, 50.11] },
                    "properties": { "id": "tk_fr_0043", "name": "Other Kiosk" },
                },
            ],
        })
        .to_string()
    }

    fn base_properties() -> serde_json::Value {
        serde_json::json!({
            "id": "tk_fr_0042",
            "name": "Trinkhalle Eichenloh",
            "address": { "street": "Eichenloh", "number": "12" },
            "tags": ["snacks"],
            "payment": { "cash": "yes" },
            "hours": { "raw": "Mo-Fr 08:00-22:00" },
        })
    }

    fn feature(doc: &str, idx: usize) -> Value {
        let v: Value = serde_json::from_str(doc).unwrap();
        v["features"][idx].clone()
    }

    #[test]
    fn wrong_hours_rewrites_hours_and_stamps_updated() {
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "wrong_hours",
            &serde_json::json!({ "new_hours": "24/7" }),
        )
        .unwrap();
        let f = feature(&out, 0);
        assert_eq!(f.pointer("/properties/hours/raw").unwrap(), "24/7");
        let updated = f.pointer("/properties/updated").unwrap().as_str().unwrap();
        assert_eq!(updated, today());
    }

    #[test]
    fn wrong_address_merges_and_preserves_untouched_keys() {
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "wrong_address",
            &serde_json::json!({ "new_address": { "number": "14" } }),
        )
        .unwrap();
        let addr = feature(&out, 0)
            .pointer("/properties/address")
            .unwrap()
            .clone();
        assert_eq!(addr["street"], "Eichenloh");
        assert_eq!(addr["number"], "14");
    }

    #[test]
    fn wrong_name_rewrites_name() {
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "wrong_name",
            &serde_json::json!({ "new_name": "Foo" }),
        )
        .unwrap();
        assert_eq!(feature(&out, 0).pointer("/properties/name").unwrap(), "Foo");
    }

    #[test]
    fn closed_deletes_the_feature() {
        // Regression: `closed` used to set a `closed:true` flag that wasn't in
        // the schema and nothing read. It must splice the feature out.
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "closed",
            &serde_json::json!({}),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let ids: Vec<&str> = v["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.pointer("/properties/id").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["tk_fr_0043"]);
        assert!(
            v["features"].as_array().unwrap().iter().all(|f| f
                .get("properties")
                .unwrap()
                .get("closed")
                .is_none())
        );
    }

    #[test]
    fn update_payment_fills_only_missing_keys() {
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "update_payment",
            &serde_json::json!({ "payment": { "cash": "no", "cards": "yes" } }),
        )
        .unwrap();
        let f = feature(&out, 0);
        let pay = f.pointer("/properties/payment").unwrap();
        assert_eq!(pay["cash"], "yes"); // pre-existing, not overwritten
        assert_eq!(pay["cards"], "yes"); // newly filled
    }

    #[test]
    fn update_tags_adds_and_removes() {
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "update_tags",
            &serde_json::json!({ "add_tags": ["wc"], "remove_tags": ["snacks"] }),
        )
        .unwrap();
        let f = feature(&out, 0);
        let tags = f.pointer("/properties/tags").unwrap();
        assert_eq!(tags, &serde_json::json!(["wc"]));
    }

    #[test]
    fn known_kind_without_actionable_data_is_a_byte_for_byte_no_op() {
        let doc = build_doc(base_properties());
        assert_eq!(
            apply_report_patch(&doc, "tk_fr_0042", "update_payment", &serde_json::json!({}))
                .unwrap(),
            doc
        );
        assert_eq!(
            apply_report_patch(&doc, "tk_fr_0042", "update_tags", &serde_json::json!({})).unwrap(),
            doc
        );
        assert_eq!(
            apply_report_patch(
                &doc,
                "tk_fr_0042",
                "update_tags",
                &serde_json::json!({ "add_tags": [], "remove_tags": [] })
            )
            .unwrap(),
            doc
        );
        assert_eq!(
            apply_report_patch(&doc, "tk_fr_0042", "wrong_hours", &serde_json::json!({})).unwrap(),
            doc
        );
    }

    #[test]
    fn ph_open_observed_appends_the_ph_rule() {
        let out = apply_report_patch(
            &build_doc(base_properties()),
            "tk_fr_0042",
            "ph_open_observed",
            &serde_json::json!({ "observation_date": "2026-10-03", "verified": true }),
        )
        .unwrap();
        assert_eq!(
            feature(&out, 0).pointer("/properties/hours/raw").unwrap(),
            "Mo-Fr 08:00-22:00; PH open"
        );
    }

    #[test]
    fn ph_open_observed_never_overrides_an_existing_ph_rule() {
        let mut props = base_properties();
        props["hours"]["raw"] = "Mo-Fr 08:00-22:00; PH off".into();
        let doc = build_doc(props);
        assert_eq!(
            apply_report_patch(
                &doc,
                "tk_fr_0042",
                "ph_open_observed",
                &serde_json::json!({ "observation_date": "2026-10-03", "verified": true })
            )
            .unwrap(),
            doc
        );
    }

    #[test]
    fn ph_open_observed_is_a_no_op_without_hours() {
        let mut props = base_properties();
        props.as_object_mut().unwrap().remove("hours");
        let doc = build_doc(props);
        assert_eq!(
            apply_report_patch(
                &doc,
                "tk_fr_0042",
                "ph_open_observed",
                &serde_json::json!({ "verified": true })
            )
            .unwrap(),
            doc
        );
    }

    #[test]
    fn unknown_kind_and_missing_feature_error() {
        assert!(
            apply_report_patch(
                &build_doc(base_properties()),
                "tk_fr_0042",
                "made_up",
                &serde_json::json!({})
            )
            .unwrap_err()
            .contains("unsupported kind")
        );
        assert!(
            apply_report_patch(
                &build_doc(base_properties()),
                "tk_does_not_exist",
                "wrong_hours",
                &serde_json::json!({})
            )
            .unwrap_err()
            .contains("not found")
        );
        assert!(
            apply_report_patch("[]", "tk_fr_0042", "wrong_hours", &serde_json::json!({}))
                .unwrap_err()
                .contains("FeatureCollection")
        );
    }

    #[test]
    fn unknown_properties_survive_a_patch() {
        let mut props = base_properties();
        props["sources_by_field"] = serde_json::json!({ "osm": ["name"] });
        props["apple_id"] = serde_json::json!("123");
        let out = apply_report_patch(
            &build_doc(props),
            "tk_fr_0042",
            "wrong_hours",
            &serde_json::json!({ "new_hours": "24/7" }),
        )
        .unwrap();
        let f = feature(&out, 0);
        assert_eq!(
            f.pointer("/properties/sources_by_field/osm/0").unwrap(),
            "name"
        );
        assert_eq!(f.pointer("/properties/apple_id").unwrap(), "123");
    }

    #[test]
    fn append_places_a_user_submission_in_the_non_osm_block() {
        let osm_only = serde_json::json!(
            { "id": "tk_fr_osm1", "name": "OSM Kiosk", "sources": [{ "type": "osm", "id": "1" }] }
        );
        let user_a = serde_json::json!(
            { "id": "tk_fr_aaa1", "name": "User A", "sources": [{ "type": "user", "id": "u1" }] }
        );
        let user_c = serde_json::json!(
            { "id": "tk_fr_ccc1", "name": "User C", "sources": [{ "type": "user", "id": "u2" }] }
        );
        let doc = serde_json::json!({
            "type": "FeatureCollection",
            "features": [
                { "type": "Feature", "geometry": { "type": "Point", "coordinates": [0.0, 0.0] }, "properties": user_a },
                { "type": "Feature", "geometry": { "type": "Point", "coordinates": [0.0, 0.0] }, "properties": user_c },
                { "type": "Feature", "geometry": { "type": "Point", "coordinates": [0.0, 0.0] }, "properties": osm_only },
            ],
        })
        .to_string();

        let new = serde_json::json!({
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [1.0, 1.0] },
            "properties": { "id": "tk_fr_bbb1", "name": "User B", "sources": [{ "type": "user", "id": "u3" }] },
        });
        let out = append_feature_to_collection(&doc, &new).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let ids: Vec<&str> = v["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.pointer("/properties/id").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec!["tk_fr_aaa1", "tk_fr_bbb1", "tk_fr_ccc1", "tk_fr_osm1"]
        );
    }

    #[test]
    fn locale_compare_is_case_insensitive_then_lower_first() {
        use std::cmp::Ordering;
        assert_eq!(locale_compare("tk_fr_a", "tk_fr_b"), Ordering::Less);
        assert_eq!(locale_compare("tk_fr_3A", "tk_fr_3a"), Ordering::Greater);
        assert_eq!(locale_compare("tk_fr_3a", "tk_fr_3A"), Ordering::Less);
        assert_eq!(locale_compare("a-b", "a_b"), Ordering::Less);
        assert_eq!(locale_compare("tk_fr_a", "tk_fr_a"), Ordering::Equal);
    }

    #[test]
    fn osm_only_detection() {
        assert!(is_osm_only(&serde_json::json!({
            "properties": { "sources": [{ "type": "osm", "id": "1" }, { "type": "osm", "id": "2" }] }
        })));
        assert!(!is_osm_only(&serde_json::json!({
            "properties": { "sources": [{ "type": "osm", "id": "1" }, { "type": "user", "id": "2" }] }
        })));
        assert!(!is_osm_only(&serde_json::json!({ "properties": {} })));
    }
}
