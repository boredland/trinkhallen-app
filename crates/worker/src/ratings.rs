//! Ratings (1–5 stars, optional comment, one per user per kiosk) — port of
//! `src/lib/ratings.ts`. Aggregates are computed on the fly in SQL: for a
//! kiosk with O(10²) ratings that is trivial, and there is no denormalised
//! counter to keep in sync.

use trinkhallen_core::i18n::{Lang, t};
use trinkhallen_ui::model::{Aggregate, RatingComment, RatingRow};
use worker::{D1Database, Result};

use crate::db;

/// `SELECT * FROM ratings WHERE kiosk_id = ? AND user_id = ?`
pub async fn get_own_rating(
    db: &D1Database,
    kiosk_id: &str,
    user_id: &str,
) -> Result<Option<RatingRow>> {
    #[derive(serde::Deserialize)]
    struct Row {
        stars: u8,
        comment: Option<String>,
        created_at: f64,
        updated_at: f64,
    }
    let row: Option<Row> = db::one(
        db,
        "SELECT * FROM ratings WHERE kiosk_id = ? AND user_id = ?",
        &[db::Arg::Text(kiosk_id), db::Arg::Text(user_id)],
    )
    .await?;
    Ok(row.map(|r| RatingRow {
        stars: r.stars,
        comment: r.comment,
        created_at: r.created_at as i64,
        updated_at: r.updated_at as i64,
    }))
}

/// Shadow-banned authors are excluded from the public aggregate. The banned
/// user still sees their own row via [`get_own_rating`] — that is the "shadow"
/// part: they don't notice they've been muted.
pub async fn get_aggregate(db: &D1Database, kiosk_id: &str) -> Result<Aggregate> {
    #[derive(serde::Deserialize)]
    struct Row {
        stars: u32,
        n: u32,
    }
    let rows: Vec<Row> = db::rows(
        db,
        "SELECT r.stars, COUNT(*) AS n
       FROM ratings r JOIN users u ON u.id = r.user_id
      WHERE r.kiosk_id = ? AND u.banned_at IS NULL
      GROUP BY r.stars",
        &[db::Arg::Text(kiosk_id)],
    )
    .await?;
    let mut histogram = [0u32; 5];
    let mut total = 0u32;
    let mut weighted = 0f64;
    for r in rows {
        let idx = r.stars as usize;
        if (1..=5).contains(&idx) {
            histogram[idx - 1] += r.n;
            total += r.n;
            weighted += (r.n * r.stars) as f64;
        }
    }
    Ok(Aggregate {
        avg: if total == 0 {
            0.0
        } else {
            weighted / total as f64
        },
        count: total,
        histogram,
    })
}

/// Ratings that carry a written comment, newest first. Banned authors are
/// excluded (same shadow-ban policy as the aggregate). The author is the
/// public @handle; every account has one, so the SSO display name never
/// appears.
pub async fn list_comments(
    db: &D1Database,
    lang: Lang,
    kiosk_id: &str,
    limit: i64,
) -> Result<Vec<RatingComment>> {
    #[derive(serde::Deserialize)]
    struct Row {
        username: Option<String>,
        stars: u8,
        comment: String,
        #[serde(rename = "updatedAt")]
        updated_at: f64,
    }
    let rows: Vec<Row> = db::rows(
        db,
        "SELECT u.username AS username,
              r.stars AS stars, r.comment AS comment, r.updated_at AS updatedAt
       FROM ratings r JOIN users u ON u.id = r.user_id
      WHERE r.kiosk_id = ?
        AND u.banned_at IS NULL
        AND r.comment IS NOT NULL
        AND TRIM(r.comment) != ''
      ORDER BY r.updated_at DESC
      LIMIT ?",
        &[db::Arg::Text(kiosk_id), db::Arg::Int(limit)],
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let author = r
                .username
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            RatingComment {
                author: author
                    .map(str::to_owned)
                    .unwrap_or_else(|| t(lang, "rating.anonymous")),
                stars: r.stars,
                comment: r.comment,
                updated_at: r.updated_at as i64,
            }
        })
        .collect())
}

pub async fn upsert_rating(
    db: &D1Database,
    kiosk_id: &str,
    user_id: &str,
    stars: u8,
    comment: Option<&str>,
) -> Result<()> {
    if !(1..=5).contains(&stars) {
        return Err(worker::Error::RustError("stars must be 1..5".into()));
    }
    let now = crate::crypto::unix_now();
    db::run(
        db,
        "INSERT INTO ratings (kiosk_id, user_id, stars, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kiosk_id, user_id) DO UPDATE SET
         stars = excluded.stars,
         comment = excluded.comment,
         updated_at = excluded.updated_at",
        &[
            db::Arg::Text(kiosk_id),
            db::Arg::Text(user_id),
            db::Arg::Int(stars as i64),
            comment.map(db::Arg::Text).unwrap_or(db::Arg::Null),
            db::Arg::Int(now),
            db::Arg::Int(now),
        ],
    )
    .await
}

pub async fn delete_rating(db: &D1Database, kiosk_id: &str, user_id: &str) -> Result<()> {
    db::run(
        db,
        "DELETE FROM ratings WHERE kiosk_id = ? AND user_id = ?",
        &[db::Arg::Text(kiosk_id), db::Arg::Text(user_id)],
    )
    .await
}

/// Banned users don't contribute to the public stats counter on `/about`.
pub async fn count_ratings(db: &D1Database) -> Result<u64> {
    let row: Option<serde_json::Value> = db::one(
        db,
        "SELECT COUNT(*) AS n
       FROM ratings r JOIN users u ON u.id = r.user_id
      WHERE u.banned_at IS NULL",
        &[],
    )
    .await?;
    Ok(row
        .and_then(|v| v.get("n").and_then(|n| n.as_u64()))
        .unwrap_or(0))
}
