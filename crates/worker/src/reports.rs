//! User-filed corrections ("Daten falsch?") — port of `src/lib/reports.ts`.
//!
//! A report is *live* while it waits for moderation or has been accepted;
//! dismissed rows are excluded on purpose, because a rejection is the
//! moderator saying "this isn't right" — the user can try again.

use trinkhallen_core::reports::{ALLOWED_KINDS, BLOCKING_STATUSES};
use trinkhallen_ui::model::UserKioskReport;
use worker::{D1Database, Result};

use crate::db;

/// Kinds `POST /api/reports` accepts.
pub fn is_allowed_kind(kind: &str) -> bool {
    ALLOWED_KINDS.contains(&kind)
}

/// Reports the user has in flight for one kiosk — used to block re-submission
/// of the same kind and to render the "you already reported X" panel.
pub async fn get_user_reports(
    db: &D1Database,
    kiosk_id: &str,
    user_id: &str,
) -> Result<Vec<UserKioskReport>> {
    #[derive(serde::Deserialize)]
    struct Row {
        id: String,
        kind: String,
        status: String,
        pr_url: Option<String>,
        created_at: f64,
    }
    let rows: Vec<Row> = db::rows(
        db,
        "SELECT id, kind, status, pr_url, created_at
       FROM reports
      WHERE kiosk_id = ? AND user_id = ?
        AND status IN (?,?,?)
      ORDER BY created_at DESC",
        &[
            db::Arg::Text(kiosk_id),
            db::Arg::Text(user_id),
            db::Arg::Text(BLOCKING_STATUSES[0]),
            db::Arg::Text(BLOCKING_STATUSES[1]),
            db::Arg::Text(BLOCKING_STATUSES[2]),
        ],
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| UserKioskReport {
            id: r.id,
            kind: r.kind,
            status: r.status,
            pr_url: r.pr_url,
            created_at: r.created_at as i64,
        })
        .collect())
}

/// One report per (user, kiosk, kind) at a time. The UI already filters out
/// kinds the user has in flight, but a stale tab + a fresh submit can still
/// race — the route rejects here too.
pub async fn has_blocking_report(
    db: &D1Database,
    kiosk_id: &str,
    user_id: &str,
    kind: &str,
) -> Result<bool> {
    let hit: Option<serde_json::Value> = db::one(
        db,
        "SELECT 1 AS n FROM reports
      WHERE kiosk_id = ? AND user_id = ? AND kind = ?
        AND status IN (?,?,?)
      LIMIT 1",
        &[
            db::Arg::Text(kiosk_id),
            db::Arg::Text(user_id),
            db::Arg::Text(kind),
            db::Arg::Text(BLOCKING_STATUSES[0]),
            db::Arg::Text(BLOCKING_STATUSES[1]),
            db::Arg::Text(BLOCKING_STATUSES[2]),
        ],
    )
    .await?;
    Ok(hit.is_some())
}

/// Insert a fresh `open` report row.
pub async fn insert_report(
    db: &D1Database,
    id: &str,
    kiosk_id: &str,
    user_id: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> Result<()> {
    let now = crate::crypto::unix_now();
    db::run(
        db,
        "INSERT INTO reports (id, kiosk_id, user_id, kind, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
        &[
            db::Arg::Text(id),
            db::Arg::Text(kiosk_id),
            db::Arg::Text(user_id),
            db::Arg::Text(kind),
            db::Arg::Text(&payload.to_string()),
            db::Arg::Int(now),
            db::Arg::Int(now),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_kinds_match_the_ts_set() {
        assert!(is_allowed_kind("wrong_hours"));
        assert!(is_allowed_kind("other"));
        assert!(!is_allowed_kind("ph_open_observed"));
    }

    #[test]
    fn blocking_statuses_block_the_live_states() {
        assert_eq!(BLOCKING_STATUSES, ["open", "pr_opened", "approved"]);
    }
}
