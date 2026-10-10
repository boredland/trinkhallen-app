//! Moderation HTTP surface — port of `src/routes/moderate.tsx`'s decision
//! endpoints and role gate (the queue *page* is rendered by the other slice;
//! [`require_moderator`] is what guards it).
//!
//! `/api/moderate/*` is POST-only here: approve/reject/ban/unban are the
//! forms the queue page submits. The language-prefixed `/en/moderate` mount
//! posts to the root endpoints, exactly as in the TS app.

pub mod decisions;
pub mod github;
pub mod github_app;
pub mod github_pr;
pub mod patch;

use worker::{Env, Method, Request, Response, Result};

use crate::http::{redirect, text};
use crate::state::RequestState;
use decisions::{KioskRow, Moderator, ReportRow, SubmissionRow, synthetic_kiosk_row};

/// Accounts deleted by their owner are anonymised onto this row; it must
/// never be banned or shown as a user (`src/lib/users.ts`).
pub const DELETED_USER_SENTINEL: &str = "00000000-0000-0000-0000-000000000000";

/// Role gate for `/moderate` and `/api/moderate/*`.
///
/// Returns `Some(response)` to reject (redirect to login, or 403 for a
/// signed-in non-moderator), `None` to let the request through.
pub fn require_moderator(state: &RequestState) -> Option<Response> {
    match &state.user {
        None => Some(redirect("/me?after=moderate", 302, &[]).ok()?),
        Some(user) if !user.role.is_moderator() => {
            Some(text("403 — moderator role required", 403).ok()?)
        }
        Some(_) => None,
    }
}

pub async fn handle(
    req: Request,
    env: &Env,
    _ctx: &worker::Context,
    state: &RequestState,
) -> Option<Result<Response>> {
    if require_moderator(state).is_some() {
        // The other slice gates before dispatching here; keep our own copy so
        // the endpoints can't be reached through a routing mistake.
        return Some(crate::http::text("403 — moderator role required", 403));
    }
    if req.method() != Method::Post {
        return Some(crate::http::text("405 — POST required", 405));
    }
    Some(dispatch(req, env, state).await)
}

async fn dispatch(req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let moderator = Moderator {
        id: state
            .user
            .as_ref()
            .map(|u| u.id.clone())
            .unwrap_or_default(),
        username: state.user.as_ref().and_then(|u| u.username.clone()),
        email: state
            .user
            .as_ref()
            .map(|u| u.email.clone())
            .unwrap_or_default(),
    };
    let path = state.path.trim_end_matches('/');
    let mut segments = path.strip_prefix("/api/moderate/").unwrap_or("").split('/');

    match (segments.next(), segments.next(), segments.next()) {
        (Some("submissions"), Some(id), Some("approve")) => {
            let Some(row) = pending_submission(env, id).await? else {
                return text("submission not pending", 404);
            };
            // Surfaced gap in the TS app: the report path wraps its approve in
            // try/catch and returns the diagnostic text, submission approve
            // 500s with a generic message. Both report it here.
            match decisions::approve_submission(env, &row, &moderator).await {
                Ok(_) => redirect("/moderate?tab=submissions", 302, &[]),
                Err(e) => {
                    worker::console_error!("approveSubmission({}) failed: {e}", row.id);
                    text(&format!("approve failed: {e}"), 500)
                }
            }
        }
        (Some("submissions"), Some(id), Some("reject")) => {
            let Some(row) = pending_submission(env, id).await? else {
                return text("submission not pending", 404);
            };
            let note = form_note(req).await?;
            decisions::reject_submission(env, &row, &moderator, note.as_deref()).await?;
            redirect("/moderate?tab=submissions", 302, &[])
        }
        (Some("reports"), Some(id), Some("approve")) => {
            let Some(row) = open_report(env, id).await? else {
                return text("report not actionable", 404);
            };
            let kiosk = report_kiosk(env, &row).await?;
            match decisions::approve_report(env, &row, &kiosk, &moderator).await {
                Ok(_) => redirect("/moderate?tab=reports", 302, &[]),
                Err(e) => {
                    worker::console_error!("approveReport({}) failed: {e}", row.id);
                    text(&format!("approve failed: {e}"), 500)
                }
            }
        }
        (Some("reports"), Some(id), Some("reject")) => {
            let Some(row) = open_report(env, id).await? else {
                return text("report not pending", 404);
            };
            let note = form_note(req).await?;
            decisions::reject_report(env, &row, &moderator, note.as_deref()).await?;
            redirect("/moderate?tab=reports", 302, &[])
        }
        (Some("users"), Some(id), Some(action @ ("ban" | "unban"))) => {
            ban_action(env, id, action, &moderator).await
        }
        _ => text("404 — Hier gibt's nix.", 404),
    }
}

/// `plans/README` surfaced list: refuse banning/unbanning non-`user` roles,
/// the acting moderator themselves, and the deleted-user sentinel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BanGuard {
    Sentinel,
    SelfTarget,
    PrivilegedRole,
}

impl BanGuard {
    pub fn message(self, verb: &str) -> &'static str {
        match self {
            BanGuard::Sentinel => match verb {
                "ban" => "cannot ban sentinel",
                _ => "cannot unban sentinel",
            },
            BanGuard::SelfTarget => match verb {
                "ban" => "cannot ban yourself",
                _ => "cannot unban yourself",
            },
            BanGuard::PrivilegedRole => match verb {
                "ban" => "cannot ban a moderator or admin",
                _ => "cannot unban a moderator or admin",
            },
        }
    }
}

pub fn ban_guard(target_id: &str, target_role: &str, actor_id: &str) -> Result<(), BanGuard> {
    if target_id == DELETED_USER_SENTINEL {
        return Err(BanGuard::Sentinel);
    }
    if target_id == actor_id {
        return Err(BanGuard::SelfTarget);
    }
    if target_role != "user" {
        return Err(BanGuard::PrivilegedRole);
    }
    Ok(())
}

async fn ban_action(env: &Env, id: &str, verb: &str, moderator: &Moderator) -> Result<Response> {
    let db = env.d1("DB")?;
    #[derive(serde::Deserialize)]
    struct RoleRow {
        role: String,
    }
    let row: Option<RoleRow> = db
        .prepare("SELECT role FROM users WHERE id = ?")
        .bind(&[wasm_bindgen::JsValue::from_str(id)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return text("user not found", 404);
    };
    if let Err(guard) = ban_guard(id, &row.role, &moderator.id) {
        return text(guard.message(verb), 400);
    }

    let now = crate::crypto::unix_now();
    match verb {
        "ban" => {
            db.prepare("UPDATE users SET banned_at = ? WHERE id = ? AND banned_at IS NULL")
                .bind(&[
                    wasm_bindgen::JsValue::from_f64(now as f64),
                    wasm_bindgen::JsValue::from_str(id),
                ])?
                .run()
                .await?;
        }
        _ => {
            db.prepare("UPDATE users SET banned_at = NULL WHERE id = ?")
                .bind(&[wasm_bindgen::JsValue::from_str(id)])?
                .run()
                .await?;
        }
    }
    redirect("/moderate?tab=users", 302, &[])
}

async fn pending_submission(env: &Env, id: &str) -> Result<Option<SubmissionRow>> {
    let db = env.d1("DB")?;
    Ok(db
        .prepare("SELECT * FROM submissions WHERE id = ? AND status = 'pending'")
        .bind(&[wasm_bindgen::JsValue::from_str(id)])?
        .first(None)
        .await?)
}

async fn open_report(env: &Env, id: &str) -> Result<Option<ReportRow>> {
    let db = env.d1("DB")?;
    Ok(db
        .prepare("SELECT * FROM reports WHERE id = ? AND status = 'open'")
        .bind(&[wasm_bindgen::JsValue::from_str(id)])?
        .first(None)
        .await?)
}

/// The kiosk a report is about. If it vanished from the dataset since the
/// report was filed, fall back to a synthetic row so the moderator can still
/// approve → issue instead of a dead-end 404.
async fn report_kiosk(env: &Env, row: &ReportRow) -> Result<KioskRow> {
    match crate::assets::get_kiosk_by_id(env, &row.kiosk_id).await? {
        Some(kiosk) => Ok(KioskRow {
            id: kiosk.id,
            region: kiosk.region,
            name: kiosk.name,
        }),
        None => {
            worker::console_warn!(
                "approveReport: kiosk {} missing from dataset — using synthetic row",
                row.kiosk_id
            );
            Ok(synthetic_kiosk_row(&row.kiosk_id))
        }
    }
}

async fn form_note(mut req: Request) -> Result<Option<String>> {
    let form = req.form_data().await?;
    Ok(form
        .get_field("note")
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty()))
}

/// Hourly cron entry: close the loop on everything we handed to GitHub.
pub async fn reconcile_all(env: &Env) -> Result<()> {
    let reports = decisions::reconcile_open_reports(env).await?;
    let submissions = decisions::reconcile_open_submissions(env).await?;
    worker::console_log!(
        "reconcile: reports +{}m/+{}d submissions +{}m/+{}d",
        reports.merged,
        reports.dismissed,
        submissions.merged,
        submissions.dismissed
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ban_guard_matrix() {
        let me = "u-mod";
        assert_eq!(
            ban_guard(DELETED_USER_SENTINEL, "user", me),
            Err(BanGuard::Sentinel)
        );
        assert_eq!(ban_guard(me, "user", me), Err(BanGuard::SelfTarget));
        assert_eq!(
            ban_guard("u-other", "moderator", me),
            Err(BanGuard::PrivilegedRole)
        );
        assert_eq!(
            ban_guard("u-other", "admin", me),
            Err(BanGuard::PrivilegedRole)
        );
        assert_eq!(ban_guard("u-other", "user", me), Ok(()));
    }

    #[test]
    fn ban_guard_messages_name_the_action() {
        assert_eq!(BanGuard::Sentinel.message("ban"), "cannot ban sentinel");
        assert_eq!(BanGuard::Sentinel.message("unban"), "cannot unban sentinel");
        assert_eq!(BanGuard::SelfTarget.message("ban"), "cannot ban yourself");
        assert_eq!(
            BanGuard::PrivilegedRole.message("unban"),
            "cannot unban a moderator or admin"
        );
    }

    #[test]
    fn sentinel_is_the_all_zero_uuid() {
        assert_eq!(
            DELETED_USER_SENTINEL,
            "00000000-0000-0000-0000-000000000000"
        );
    }
}
