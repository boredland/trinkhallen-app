//! Check-in event log + strict verified-presence primitive (including the PH
//! observation filing of the check-in API).
//!
//! Both paths share one accuracy-aware fence: the GPS fix's reported accuracy
//! pads [`VERIFY_RADIUS_M`] up to [`ACCURACY_CAP_M`] so a noisy urban fix at
//! the kiosk still counts, while a 5000 m "accuracy" can't pretend you're
//! anywhere. The cap is what makes the fence honest.

use chrono::{DateTime, Utc};
use trinkhallen_core::geo::{LatLng, haversine_meters};
use trinkhallen_core::hours::{has_ph_token, is_public_holiday};
use trinkhallen_core::regions::bundesland_for_region;
use worker::{Context, D1Database, Env, Result};

use crate::db;
use crate::notify::{ReportNotification, notify_new_report};
use crate::util;

pub const VERIFY_RADIUS_M: f64 = 100.0;
pub const ACCURACY_CAP_M: f64 = 250.0;
/// ~500 km/h; tune on recorded data later.
pub const MAX_TRAVEL_MPS: f64 = 139.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyReason {
    NoFix,
    OutOfRange,
    LowAccuracy,
}

impl VerifyReason {
    pub fn code(self) -> &'static str {
        match self {
            VerifyReason::NoFix => "no_fix",
            VerifyReason::OutOfRange => "out_of_range",
            VerifyReason::LowAccuracy => "low_accuracy",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct VerifyPresenceResult {
    pub verified: bool,
    pub distance: Option<f64>,
    pub reason: Option<VerifyReason>,
}

/// Decide whether the user is verifiably at the kiosk. The soft "Ich war hier"
/// tap just records `verified`; the strict (rewarded) path hard-blocks on
/// anything but `verified: true` and surfaces `reason` to the user.
pub fn verify_presence(
    kiosk: LatLng,
    user: Option<LatLng>,
    accuracy: Option<f64>,
) -> VerifyPresenceResult {
    let Some(user) = user else {
        return VerifyPresenceResult {
            verified: false,
            distance: None,
            reason: Some(VerifyReason::NoFix),
        };
    };
    let distance = haversine_meters(user, kiosk);
    let acc = accuracy.filter(|a| *a >= 0.0).unwrap_or(0.0);
    let allowance = VERIFY_RADIUS_M + acc.min(ACCURACY_CAP_M);
    if distance <= allowance {
        return VerifyPresenceResult {
            verified: true,
            distance: Some(distance),
            reason: None,
        };
    }
    // Out of range with a wildly-large accuracy ⇒ the fix itself is the
    // problem; surface that so the strict path can say "couldn't confirm
    // you're here" rather than "you're not here".
    let reason = if acc > ACCURACY_CAP_M {
        VerifyReason::LowAccuracy
    } else {
        VerifyReason::OutOfRange
    };
    VerifyPresenceResult {
        verified: false,
        distance: Some(distance),
        reason: Some(reason),
    }
}

pub struct CheckinInput<'a> {
    pub kiosk_id: &'a str,
    pub kiosk: LatLng,
    /// Region slug derived from `kiosk.region` (see [`region_slug_from_path`]).
    pub region_slug: &'a str,
    pub user_id: &'a str,
    /// Browser geolocation, if the user granted it.
    pub user: Option<LatLng>,
    /// GPS accuracy radius in metres — pads the verify radius.
    pub accuracy: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
pub struct CheckinOutcome {
    /// `false` when the UNIQUE (kiosk, user, day) index already had a row.
    pub inserted: bool,
    pub verified: bool,
    /// Set when not verified — callers can explain why.
    pub reason: Option<VerifyReason>,
}

/// The soft "Ich war hier" tap: a fix is never required and same-day re-taps
/// dedup via the UNIQUE index (migration 0006).
pub async fn record_checkin(env: &Env, input: &CheckinInput<'_>) -> Result<CheckinOutcome> {
    let db = env.d1("DB")?;
    let presence = verify_presence(input.kiosk, input.user, input.accuracy);
    let id = crate::auth::users::uuid_v4();
    let now = util::now();
    let day = chrono_day(now);

    // INSERT OR IGNORE: the UNIQUE (kiosk_id, user_id, created_day) index
    // makes a same-day re-tap a no-op without throwing.
    let changed = db::changes(
        &db,
        "INSERT OR IGNORE INTO checkins
       (id, kiosk_id, user_id, region_slug, verified, created_at, created_day, accuracy, distance_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            db::Arg::Text(&id),
            db::Arg::Text(input.kiosk_id),
            db::Arg::Text(input.user_id),
            db::Arg::Text(input.region_slug),
            db::Arg::Int(if presence.verified { 1 } else { 0 }),
            db::Arg::Int(now),
            db::Arg::Text(&day),
            input.accuracy.map(db::Arg::Real).unwrap_or(db::Arg::Null),
            presence
                .distance
                .map(db::Arg::Real)
                .unwrap_or(db::Arg::Null),
        ],
    )
    .await?;
    let inserted = changed > 0;

    if inserted && presence.verified {
        // Detection is a backstop, not a blocker — failure must not fail the tap.
        if let Err(err) = detect_impossible_travel(
            env,
            &db,
            input.user_id,
            &id,
            input.kiosk_id,
            input.kiosk,
            now,
        )
        .await
        {
            worker::console_error!("impossible-travel check failed: {err}");
        }
    }

    Ok(CheckinOutcome {
        inserted,
        verified: presence.verified,
        reason: presence.reason,
    })
}

/// `YYYY-MM-DD` in UTC — the day bucket the UNIQUE index keys on.
fn chrono_day(now: i64) -> String {
    DateTime::from_timestamp(now, 0)
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Same user, verified at a distant kiosk implausibly recently ⇒ an anomaly
/// row for moderator review. Client coords are spoofable anyway, so this is
/// a backstop and never blocks the check-in.
async fn detect_impossible_travel(
    env: &Env,
    db: &D1Database,
    user_id: &str,
    current_checkin_id: &str,
    kiosk_id: &str,
    kiosk: LatLng,
    now_sec: i64,
) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Prev {
        #[serde(rename = "prevKioskId")]
        prev_kiosk_id: String,
        #[serde(rename = "prevAt")]
        prev_at: f64,
    }
    let prev: Option<Prev> = db::one(
        db,
        "SELECT kiosk_id AS prevKioskId, created_at AS prevAt
       FROM checkins
      WHERE user_id = ? AND verified = 1 AND id != ?
      ORDER BY created_at DESC
      LIMIT 1",
        &[db::Arg::Text(user_id), db::Arg::Text(current_checkin_id)],
    )
    .await?;
    let Some(prev) = prev else { return Ok(()) };
    if prev.prev_kiosk_id == kiosk_id {
        return Ok(());
    }
    let Some(prev_kiosk) = crate::assets::get_kiosk_by_id(env, &prev.prev_kiosk_id).await? else {
        return Ok(());
    };
    let distance = haversine_meters(
        LatLng {
            lat: prev_kiosk.lat,
            lng: prev_kiosk.lng,
        },
        kiosk,
    );
    let seconds = (now_sec - prev.prev_at as i64).max(1);
    if distance / seconds as f64 <= MAX_TRAVEL_MPS {
        return Ok(());
    }

    let payload = serde_json::json!({
        "from_kiosk_id": prev.prev_kiosk_id,
        "to_kiosk_id": kiosk_id,
        "distance_m": distance.round(),
        "seconds": seconds,
        "kmh": (distance / seconds as f64 * 3.6).round(),
    });
    db::run(
        db,
        "INSERT INTO user_anomalies (id, user_id, kind, payload, created_at)
       VALUES (?, ?, 'impossible_travel', ?, ?)",
        &[
            db::Arg::Text(&crate::auth::users::uuid_v4()),
            db::Arg::Text(user_id),
            db::Arg::Text(&payload.to_string()),
            db::Arg::Int(now_sec),
        ],
    )
    .await
}

/// Pull a region slug out of `kiosk.region` — a repo-style path like
/// `de/hessen/frankfurt` in the data repo, already a bare slug here.
pub fn region_slug_from_path(region: &str) -> String {
    let trimmed = region.strip_suffix(".geojson").unwrap_or(region);
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_owned()
}

/// Auto-file a `ph_open_observed` report so the moderator can confirm and the
/// existing approval flow appends `; PH open` to the data-repo hours. Dedupes
/// on (kiosk_id, observation_date): one report per Späti per public holiday.
pub async fn file_observation_if_new(
    env: &Env,
    ctx: &Context,
    kiosk_id: &str,
    kiosk_name: &str,
    reporter: &str,
    user_id: &str,
    observation_date: &str,
) -> Result<()> {
    let db = env.d1("DB")?;
    let existing: Option<serde_json::Value> = db::one(
        &db,
        "SELECT 1 AS n FROM reports
       WHERE kiosk_id = ?
         AND kind = 'ph_open_observed'
         AND json_extract(payload, '$.observation_date') = ?
       LIMIT 1",
        &[db::Arg::Text(kiosk_id), db::Arg::Text(observation_date)],
    )
    .await?;
    if existing.is_some() {
        return Ok(());
    }

    let id = crate::auth::users::uuid_v4();
    let now = util::now();
    let payload = serde_json::json!({ "observation_date": observation_date, "verified": true });
    db::run(
        &db,
        "INSERT INTO reports (id, kiosk_id, user_id, kind, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ph_open_observed', ?, 'open', ?, ?)",
        &[
            db::Arg::Text(&id),
            db::Arg::Text(kiosk_id),
            db::Arg::Text(user_id),
            db::Arg::Text(&payload.to_string()),
            db::Arg::Int(now),
            db::Arg::Int(now),
        ],
    )
    .await?;

    // Deduped above, so this is at most one mail per kiosk per public holiday.
    notify_new_report(
        env,
        ctx,
        ReportNotification {
            id,
            kiosk_id: kiosk_id.to_owned(),
            kiosk_name: kiosk_name.to_owned(),
            kind: "ph_open_observed".to_owned(),
            payload,
            reporter: reporter.to_owned(),
        },
    );
    Ok(())
}

/// PH-data-gap capture: a verified check-in landing on a public holiday at a
/// kiosk whose hours carry no `PH` rule. Returns the observation date when a
/// (deduped) report should be filed.
pub fn ph_observation_date(
    hours_raw: Option<&str>,
    region: &str,
    now: DateTime<Utc>,
) -> Option<String> {
    if hours_raw.is_none_or(|raw| has_ph_token(Some(raw))) {
        return None;
    }
    let state = bundesland_for_region(region)?;
    if !is_public_holiday(Some(state), now) {
        return None;
    }
    Some(now.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kiosk() -> LatLng {
        LatLng {
            lat: 50.11,
            lng: 8.68,
        }
    }

    #[test]
    fn verified_within_the_accuracy_padded_radius() {
        // ~10 m north-east of the kiosk.
        let user = LatLng {
            lat: 50.11009,
            lng: 8.6801,
        };
        let r = verify_presence(kiosk(), Some(user), Some(30.0));
        assert!(r.verified);
        assert!(r.reason.is_none());
    }

    #[test]
    fn no_fix_is_not_verified() {
        let r = verify_presence(kiosk(), None, None);
        assert!(!r.verified);
        assert_eq!(r.reason, Some(VerifyReason::NoFix));
        assert_eq!(r.distance, None);
    }

    #[test]
    fn out_of_range_and_low_accuracy_are_distinguished() {
        let far = LatLng {
            lat: 50.2,
            lng: 8.68,
        }; // ~10 km
        let r = verify_presence(kiosk(), Some(far), None);
        assert!(!r.verified);
        assert_eq!(r.reason, Some(VerifyReason::OutOfRange));
        // A wildly-large accuracy can't expand the fence past the cap …
        let r = verify_presence(kiosk(), Some(far), Some(5000.0));
        assert!(!r.verified);
        assert_eq!(r.reason, Some(VerifyReason::LowAccuracy));
    }

    #[test]
    fn region_slug_falls_back_to_the_last_segment() {
        assert_eq!(region_slug_from_path("de/hessen/frankfurt"), "frankfurt");
        assert_eq!(region_slug_from_path("frankfurt"), "frankfurt");
        assert_eq!(
            region_slug_from_path("data/de/hessen/frankfurt.geojson"),
            "frankfurt"
        );
    }
}
