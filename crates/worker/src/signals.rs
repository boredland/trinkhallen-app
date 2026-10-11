//! Per-field signal log.
//!
//! `record_signal` **always records** the signal; the `verified` column
//! captures whether the user had a fresh in-range fix. Decoupling the capture
//! from the gate means later phases can weight `verified=1` heavily without
//! losing the data in the meantime. Daily dedup via the UNIQUE
//! (user, kiosk, field, day) index caps spam regardless.

use chrono::DateTime;
use trinkhallen_core::geo::LatLng;
use worker::{D1Database, Result};

use crate::checkins::{VerifyReason, verify_presence};
use crate::db;
use crate::util;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalAction {
    Confirm,
    Dispute,
    Fill,
}

impl SignalAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "confirm" => Some(SignalAction::Confirm),
            "dispute" => Some(SignalAction::Dispute),
            "fill" => Some(SignalAction::Fill),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            SignalAction::Confirm => "confirm",
            SignalAction::Dispute => "dispute",
            SignalAction::Fill => "fill",
        }
    }
}

pub struct RecordSignalInput<'a> {
    pub kiosk_id: &'a str,
    pub kiosk: LatLng,
    pub region_slug: &'a str,
    pub user_id: &'a str,
    pub field_key: &'a str,
    pub action: SignalAction,
    /// Only used for `dispute` / `fill`; ignored on `confirm`.
    pub asserted_value: Option<&'a str>,
    pub user: Option<LatLng>,
    pub accuracy: Option<f64>,
}

pub struct RecordSignalResult {
    /// `false` iff the UNIQUE (user, kiosk, field, day) index already had a row.
    pub inserted: bool,
    pub signal_id: String,
    pub verified: bool,
    /// The reason [`verify_presence`] rejected — not persisted.
    pub reason: Option<VerifyReason>,
}

pub async fn record_signal(
    db: &D1Database,
    input: &RecordSignalInput<'_>,
) -> Result<RecordSignalResult> {
    let presence = verify_presence(input.kiosk, input.user, input.accuracy);
    let id = crate::auth::users::uuid_v4();
    let now = util::now();
    let day = DateTime::from_timestamp(now, 0)
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let asserted = match input.action {
        SignalAction::Confirm => None,
        _ => input.asserted_value,
    };

    let changed = db::changes(
        db,
        "INSERT OR IGNORE INTO field_signals
       (id, kiosk_id, field_key, action, asserted_value, user_id, verified, region_slug, created_at, created_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            db::Arg::Text(&id),
            db::Arg::Text(input.kiosk_id),
            db::Arg::Text(input.field_key),
            db::Arg::Text(input.action.code()),
            asserted.map(db::Arg::Text).unwrap_or(db::Arg::Null),
            db::Arg::Text(input.user_id),
            db::Arg::Int(if presence.verified { 1 } else { 0 }),
            db::Arg::Text(input.region_slug),
            db::Arg::Int(now),
            db::Arg::Text(&day),
        ],
    )
    .await?;

    Ok(RecordSignalResult {
        inserted: changed > 0,
        signal_id: id,
        verified: presence.verified,
        reason: presence.reason,
    })
}
