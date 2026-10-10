//! `POST /add` — validate a proposed Kiosk Feature and park it in
//! `submissions` for moderator review.
//!
//! The stored payload is a GeoJSON Feature so moderation can diff it against
//! the data repo's files without a translation layer.

use worker::{D1Database, FormData, Result};

use crate::db;
use crate::util;

/// Field mapping of the `/add` form. `None` is a validation failure — the
/// route turns it into the `?error=basics` / `?error=coords` redirect.
pub fn build_feature(form: &FormData) -> Option<serde_json::Value> {
    let lat = field(form, "lat").parse::<f64>().ok()?;
    let lng = field(form, "lng").parse::<f64>().ok()?;
    let name = field(form, "name").trim().to_owned();
    if name.is_empty() || !lat.is_finite() || !lng.is_finite() {
        return None;
    }
    if lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0 {
        return None;
    }

    let mut address = serde_json::Map::new();
    for key in ["street", "number", "postalcode", "city", "district"] {
        let mut v = field(form, key).trim().to_owned();
        // The postal code is only kept when it is exactly five digits.
        if key == "postalcode" && !(v.len() == 5 && v.bytes().all(|b| b.is_ascii_digit())) {
            v = String::new();
        }
        if !v.is_empty() {
            address.insert(key.to_owned(), serde_json::Value::String(v));
        }
    }

    let mut properties = serde_json::Map::new();
    properties.insert("name".into(), serde_json::Value::String(name));
    properties.insert("address".into(), serde_json::Value::Object(address));

    let description = field(form, "description").trim().to_owned();
    if !description.is_empty() {
        properties.insert("description".into(), clip(&description, 2000).into());
    }
    let hours = field(form, "hours_raw").trim().to_owned();
    if !hours.is_empty() {
        properties.insert(
            "hours".into(),
            serde_json::json!({ "raw": clip(&hours, 200) }),
        );
    }

    // Multi-select tags arrive as repeated `tags` keys.
    let tags: Vec<serde_json::Value> = form
        .get_all("tags")
        .unwrap_or_default()
        .iter()
        .filter_map(|e| match e {
            worker::FormEntry::Field(v) if !v.is_empty() => {
                Some(serde_json::Value::String(v.clone()))
            }
            _ => None,
        })
        .take(30)
        .collect();
    if !tags.is_empty() {
        properties.insert("tags".into(), serde_json::Value::Array(tags));
    }

    let mut payment = serde_json::Map::new();
    for key in ["cash", "cards", "contactless", "girocard"] {
        let v = field(form, &format!("pay_{key}")).trim().to_owned();
        if v == "yes" || v == "no" || v == "unknown" {
            payment.insert(key.into(), v.into());
        }
    }
    if !payment.is_empty() {
        properties.insert("payment".into(), serde_json::Value::Object(payment));
    }

    Some(serde_json::json!({
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": [lng, lat] },
        "properties": properties,
    }))
}

/// Submissions sit in D1 with `status='pending'` until a moderator approves
/// on `/moderate`; approval is what opens the PR.
pub async fn store_submission(
    db: &D1Database,
    user_id: &str,
    feature: &serde_json::Value,
) -> Result<()> {
    let now = util::now();
    db::run(
        db,
        "INSERT INTO submissions (id, user_id, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)",
        &[
            db::Arg::Text(&crate::auth::users::uuid_v4()),
            db::Arg::Text(user_id),
            db::Arg::Text(&feature.to_string()),
            db::Arg::Int(now),
            db::Arg::Int(now),
        ],
    )
    .await
}

fn field(form: &FormData, name: &str) -> String {
    form.get_field(name).unwrap_or_default()
}

/// `String.prototype.slice(0, n)` on the char count.
fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
