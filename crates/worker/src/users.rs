//! Account helpers: the themed handle generator, the change-once rename and
//! account deletion.

use worker::{D1Database, Result};

use trinkhallen_core::usernames::{
    PERSONAS, PREFIXES, handle_candidate, handle_candidate_wide, validate_username,
};

use crate::db;
use crate::util::random_int;

/// Re-exported so there is exactly one definition in the crate (the
/// moderation slice needs it for the ban guard).
pub use crate::moderation::DELETED_USER_SENTINEL;

/// A freed handle is never recycled: both tables take part in the lookup.
async fn is_handle_free(db: &D1Database, value: &str) -> Result<bool> {
    let hit: Option<serde_json::Value> = db::one(
        db,
        "SELECT 1 FROM users WHERE lower(username) = ?1
       UNION ALL
       SELECT 1 FROM retired_usernames WHERE lower(username) = ?1
       LIMIT 1",
        &[db::Arg::Text(value)],
    )
    .await?;
    Ok(hit.is_none())
}

/// Auto-assign a unique, valid, themed handle (`pfand_pirat_4821`).
pub async fn generate_unique_username(db: &D1Database) -> Result<String> {
    for _ in 0..60 {
        let candidate = handle_candidate(
            random_int(PREFIXES.len() as u32),
            random_int(PERSONAS.len() as u32),
            random_int(9990),
        );
        if let Ok(value) = validate_username(&candidate) {
            if is_handle_free(db, &value).await? {
                return Ok(value);
            }
        }
    }
    // Pathological-collision fallback: same vocab, wider suffix.
    loop {
        let candidate =
            handle_candidate_wide(random_int(PERSONAS.len() as u32), random_int(1_000_000));
        if let Ok(value) = validate_username(&candidate) {
            if is_handle_free(db, &value).await? {
                return Ok(value);
            }
        }
    }
}

/// Every failure mode has its own variant so `/me` can pick a precise flash
/// banner (`?username=<code>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenameResult {
    Ok,
    Taken,
    Invalid,
    Reserved,
    Retired,
    Unchanged,
    AlreadyChanged,
}

impl RenameResult {
    pub fn code(self) -> &'static str {
        match self {
            RenameResult::Ok => "ok",
            RenameResult::Taken => "taken",
            RenameResult::Invalid => "invalid",
            RenameResult::Reserved => "reserved",
            RenameResult::Retired => "retired",
            RenameResult::Unchanged => "unchanged",
            RenameResult::AlreadyChanged => "already_changed",
        }
    }
}

/// The one-change guard lives in SQL (`WHERE username_changed_at IS NULL`) so
/// two concurrent submits can't both stamp; a UNIQUE violation surfaces as
/// `Taken` rather than a 500.
pub async fn rename_username(
    db: &D1Database,
    user_id: &str,
    candidate: &str,
) -> Result<RenameResult> {
    let value = match validate_username(candidate) {
        Ok(v) => v,
        Err(e) => {
            return Ok(match e {
                trinkhallen_core::usernames::Invalid::Invalid => RenameResult::Invalid,
                trinkhallen_core::usernames::Invalid::Reserved => RenameResult::Reserved,
            });
        }
    };

    #[derive(serde::Deserialize)]
    struct Current {
        username: Option<String>,
        #[serde(rename = "changedAt")]
        changed_at: Option<f64>,
    }
    let cur: Option<Current> = db::one(
        db,
        "SELECT username, username_changed_at AS changedAt FROM users WHERE id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await?;
    let Some(cur) = cur else {
        return Ok(RenameResult::Invalid);
    };
    if cur.changed_at.is_some() {
        return Ok(RenameResult::AlreadyChanged);
    }
    if cur
        .username
        .as_deref()
        .is_some_and(|u| u.to_lowercase() == value)
    {
        return Ok(RenameResult::Unchanged);
    }

    let retired: Option<serde_json::Value> = db::one(
        db,
        "SELECT 1 FROM retired_usernames WHERE lower(username) = ?",
        &[db::Arg::Text(&value)],
    )
    .await?;
    if retired.is_some() {
        return Ok(RenameResult::Retired);
    }

    let now = crate::crypto::unix_now();
    let updated = db::changes(
        db,
        "UPDATE users SET username = ?, username_changed_at = ?
          WHERE id = ? AND username_changed_at IS NULL",
        &[
            db::Arg::Text(&value),
            db::Arg::Int(now),
            db::Arg::Text(user_id),
        ],
    )
    .await;
    match updated {
        Ok(0) => return Ok(RenameResult::AlreadyChanged),
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => return Ok(RenameResult::Taken),
        Err(e) => return Err(e),
    }

    if let Some(old) = cur.username {
        db::run(
            db,
            "INSERT OR IGNORE INTO retired_usernames (username, retired_at) VALUES (?, ?)",
            &[db::Arg::Text(&old.to_lowercase()), db::Arg::Int(now)],
        )
        .await?;
    }
    Ok(RenameResult::Ok)
}

fn is_unique_violation(err: &worker::Error) -> bool {
    format!("{err:?}").contains("UNIQUE constraint failed")
}

/// "Real" registered accounts for the `/about` stats block: banned users and
/// the deleted-account sentinel don't contribute.
pub async fn count_users(db: &D1Database) -> Result<u64> {
    let row: Option<serde_json::Value> = db::one(
        db,
        "SELECT COUNT(*) AS n
           FROM users
          WHERE banned_at IS NULL
            AND id != ?",
        &[db::Arg::Text(DELETED_USER_SENTINEL)],
    )
    .await?;
    Ok(row
        .and_then(|v| v.get("n").and_then(|n| n.as_u64()))
        .unwrap_or(0))
}

/// Hard-delete an account: anonymise the contributions that already escaped
/// to trinkhallen-data (a PR was opened or merged), then remove everything
/// personal. Ratings, sessions and check-ins cascade on the users row, but
/// they are explicit-deleted too so the order stays unambiguous.
pub async fn delete_account(db: &D1Database, user_id: &str, email: &str) -> Result<()> {
    db::run(
        db,
        "UPDATE reports SET user_id = ?
           WHERE user_id = ? AND status IN ('pr_opened', 'merged')",
        &[db::Arg::Text(DELETED_USER_SENTINEL), db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "UPDATE submissions SET user_id = ?
           WHERE user_id = ? AND status IN ('pr_opened', 'merged')",
        &[db::Arg::Text(DELETED_USER_SENTINEL), db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM reports WHERE user_id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM submissions WHERE user_id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM ratings WHERE user_id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM checkins WHERE user_id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM sessions WHERE user_id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM magic_links WHERE email = ?",
        &[db::Arg::Text(email)],
    )
    .await?;
    db::run(
        db,
        "DELETE FROM users WHERE id = ?",
        &[db::Arg::Text(user_id)],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_handles_validate() {
        for (a, b, c) in [(0u32, 0, 0), (33, 31, 9989), (u32::MAX, u32::MAX, u32::MAX)] {
            let h = handle_candidate(a, b, c);
            assert!(validate_username(&h).is_ok(), "{h}");
        }
        assert!(validate_username(&handle_candidate_wide(7, 999_999)).is_ok());
    }

    #[test]
    fn rename_result_codes_match_the_ts_flash_flags() {
        assert_eq!(RenameResult::Ok.code(), "ok");
        assert_eq!(RenameResult::AlreadyChanged.code(), "already_changed");
        assert_eq!(RenameResult::Retired.code(), "retired");
    }
}
