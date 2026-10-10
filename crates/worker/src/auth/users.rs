//! `users` rows for the auth flows.
//!
//! Three synthetic `google_sub` conventions exist because the column is
//! `NOT NULL UNIQUE` and the app has three ways to create an account:
//! `email:<addr>` for magic-link signups, `apple:<sub>` for Apple-only
//! signups, and the real Google sub. `has_google` in the session is derived
//! from which one is present.

use worker::{D1Database, Result};

use crate::users::generate_unique_username;

#[derive(serde::Deserialize)]
struct IdRow {
    id: String,
}

#[derive(serde::Deserialize)]
struct EmailSubRow {
    id: String,
    google_sub: String,
}

/// Attach a Google identity to the currently-logged-in user. Used by the
/// /me "Google verbinden" flow, where the security model is:
///   - The user proved they own this row in the past (magic-link email or
///     prior Google login), and the session cookie carries that.
///   - Google just freshly verified that the same browser controls a
///     Google account with sub=profile.id.
/// Linking them is safe regardless of email match, so don't gate on it.
///
/// Returns `false` ("conflict") when the Google sub is already attached to a
/// different account, which would need a separate consolidation flow.
pub async fn link_google_to_current_user(
    db: &D1Database,
    user_id: &str,
    google_sub: &str,
) -> Result<bool> {
    let other: Option<IdRow> = db
        .prepare("SELECT id FROM users WHERE google_sub = ? AND id != ?")
        .bind(&[
            wasm_bindgen::JsValue::from_str(google_sub),
            wasm_bindgen::JsValue::from_str(user_id),
        ])?
        .first(None)
        .await?;
    if other.is_some() {
        return Ok(false);
    }
    // Attach the Google identity only — no SSO profile data (name or picture) is
    // stored.
    db.prepare("UPDATE users SET google_sub = ? WHERE id = ?")
        .bind(&[
            wasm_bindgen::JsValue::from_str(google_sub),
            wasm_bindgen::JsValue::from_str(user_id),
        ])?
        .run()
        .await?;
    Ok(true)
}

/// Magic-link login/registration: reuse the row for the address or create
/// one with the synthetic `email:` sub.
pub async fn upsert_user_by_email(db: &D1Database, email: &str, now: i64) -> Result<String> {
    let existing: Option<IdRow> = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(email)])?
        .first(None)
        .await?;
    if let Some(row) = existing {
        return Ok(row.id);
    }
    let id = uuid_v4();
    // For magic-link signups we use the email as a synthetic google_sub so the
    // unique constraint holds; if the user later links Google, we overwrite it.
    let synthetic_sub = format!("email:{email}");
    let username = generate_unique_username(db).await?;
    db.prepare(
        "INSERT INTO users (id, google_sub, email, role, created_at, username)
         VALUES (?, ?, ?, 'user', ?, ?)",
    )
    .bind(&[
        wasm_bindgen::JsValue::from_str(&id),
        wasm_bindgen::JsValue::from_str(&synthetic_sub),
        wasm_bindgen::JsValue::from_str(email),
        wasm_bindgen::JsValue::from_f64(now as f64),
        wasm_bindgen::JsValue::from_str(&username),
    ])?
    .run()
    .await?;
    Ok(id)
}

/// Google sign-in without a session. `email_verified` gates the merge branch:
/// Workspace admins can put an unverified address on their profile, which
/// must never take over a magic-link account.
pub async fn upsert_user_google(
    db: &D1Database,
    google_sub: &str,
    email: &str,
    email_verified: bool,
    now: i64,
) -> Result<String> {
    // 1. Already-linked account — direct google_sub hit.
    let existing: Option<IdRow> = db
        .prepare("SELECT id FROM users WHERE google_sub = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(google_sub)])?
        .first(None)
        .await?;
    if let Some(row) = existing {
        // Refresh the email opportunistically; no SSO profile data is stored.
        db.prepare("UPDATE users SET email = ? WHERE id = ?")
            .bind(&[
                wasm_bindgen::JsValue::from_str(email),
                wasm_bindgen::JsValue::from_str(&row.id),
            ])?
            .run()
            .await?;
        return Ok(row.id);
    }

    // 2. Magic-link signup being linked to Google. Both Google and our own
    //    magic-link have verified this email, so transparently upgrading the
    //    row is safe. Guard on `email:` prefix so a real Google sub belonging
    //    to a different person sharing the email never gets clobbered.
    let by_email: Option<EmailSubRow> = db
        .prepare("SELECT id, google_sub FROM users WHERE email = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(email)])?
        .first(None)
        .await?;
    if let Some(row) = by_email.filter(|r| email_verified && r.google_sub.starts_with("email:")) {
        db.prepare("UPDATE users SET google_sub = ? WHERE id = ?")
            .bind(&[
                wasm_bindgen::JsValue::from_str(google_sub),
                wasm_bindgen::JsValue::from_str(&row.id),
            ])?
            .run()
            .await?;
        return Ok(row.id);
    }

    // 3. Brand-new user.
    let id = uuid_v4();
    let username = generate_unique_username(db).await?;
    db.prepare(
        "INSERT INTO users (id, google_sub, email, role, created_at, username)
         VALUES (?, ?, ?, 'user', ?, ?)",
    )
    .bind(&[
        wasm_bindgen::JsValue::from_str(&id),
        wasm_bindgen::JsValue::from_str(google_sub),
        wasm_bindgen::JsValue::from_str(email),
        wasm_bindgen::JsValue::from_f64(now as f64),
        wasm_bindgen::JsValue::from_str(&username),
    ])?
    .run()
    .await?;
    Ok(id)
}

/// Apple link mode — mirrors [`link_google_to_current_user`].
pub async fn link_apple_to_current_user(
    db: &D1Database,
    user_id: &str,
    apple_sub: &str,
) -> Result<bool> {
    let other: Option<IdRow> = db
        .prepare("SELECT id FROM users WHERE apple_sub = ? AND id != ?")
        .bind(&[
            wasm_bindgen::JsValue::from_str(apple_sub),
            wasm_bindgen::JsValue::from_str(user_id),
        ])?
        .first(None)
        .await?;
    if other.is_some() {
        return Ok(false);
    }
    db.prepare("UPDATE users SET apple_sub = ? WHERE id = ?")
        .bind(&[
            wasm_bindgen::JsValue::from_str(apple_sub),
            wasm_bindgen::JsValue::from_str(user_id),
        ])?
        .run()
        .await?;
    Ok(true)
}

/// Upsert via Apple. Mirrors [`upsert_user_google`] but users come in without
/// a google_sub, and `users.google_sub` is NOT NULL UNIQUE — hence the
/// synthetic `apple:<sub>` placeholder the same way magic-link uses
/// `email:<addr>`.
pub async fn upsert_user_apple(
    db: &D1Database,
    apple_sub: &str,
    email: &str,
    email_verified: bool,
    now: i64,
) -> Result<String> {
    let existing: Option<IdRow> = db
        .prepare("SELECT id FROM users WHERE apple_sub = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(apple_sub)])?
        .first(None)
        .await?;
    if let Some(row) = existing {
        db.prepare("UPDATE users SET email = ? WHERE id = ?")
            .bind(&[
                wasm_bindgen::JsValue::from_str(email),
                wasm_bindgen::JsValue::from_str(&row.id),
            ])?
            .run()
            .await?;
        return Ok(row.id);
    }

    let by_email: Option<EmailSubRow> = db
        .prepare("SELECT id, google_sub FROM users WHERE email = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(email)])?
        .first(None)
        .await?;
    if let Some(row) = by_email.filter(|r| email_verified && r.google_sub.starts_with("email:")) {
        db.prepare("UPDATE users SET apple_sub = ? WHERE id = ?")
            .bind(&[
                wasm_bindgen::JsValue::from_str(apple_sub),
                wasm_bindgen::JsValue::from_str(&row.id),
            ])?
            .run()
            .await?;
        return Ok(row.id);
    }

    let id = uuid_v4();
    let synthetic_google_sub = format!("apple:{apple_sub}");
    let username = generate_unique_username(db).await?;
    db.prepare(
        "INSERT INTO users (id, google_sub, apple_sub, email, role, created_at, username)
         VALUES (?, ?, ?, ?, 'user', ?, ?)",
    )
    .bind(&[
        wasm_bindgen::JsValue::from_str(&id),
        wasm_bindgen::JsValue::from_str(&synthetic_google_sub),
        wasm_bindgen::JsValue::from_str(apple_sub),
        wasm_bindgen::JsValue::from_str(email),
        wasm_bindgen::JsValue::from_f64(now as f64),
        wasm_bindgen::JsValue::from_str(&username),
    ])?
    .run()
    .await?;
    Ok(id)
}

/// `crypto.randomUUID()` — 16 random bytes with the RFC 4122 v4 layout.
pub fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = crate::crypto::hex_encode(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v4_shape() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_eq!(id.chars().filter(|c| *c == '-').count(), 4);
    }
}
