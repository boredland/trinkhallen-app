//! Moderation decisions — port of `src/lib/moderation.ts`.
//!
//! `approve_submission` / `approve_report` resolve the change, open a PR via
//! the GitHub App, and update the D1 row with the PR URL + status. Rejection
//! is a single D1 update — no GitHub action. When the GitHub App isn't
//! configured, approvals still update D1 (status "approved", pr_url null) so
//! moderators can act now and PRs get backfilled once it is provisioned.

use worker::{D1Database, Result};

use super::github_app::has_github_app_creds;
use super::github_pr::{
    CreatedPr, UpstreamOutcome, fetch_upstream_outcome, open_issue_via_pr, propose_change,
};
use super::patch::{append_feature_to_collection, apply_report_patch, today};
use crate::crypto::unix_now;
use trinkhallen_core::regions::{
    parse_prefix, resolve_region_by_coords, resolve_region_by_prefix, resolve_region_by_slug,
};

const APP_ORIGIN: &str = "https://trinkhallen.app";

#[derive(Debug, Clone)]
pub struct Moderator {
    pub id: String,
    pub username: Option<String>,
    pub email: String,
}

/// Pick a human-readable handle for the moderator on PR/issue bodies. Every
/// account has an auto-generated handle, so the username branch is the common
/// path; the email local-part is the last-resort fallback — historically that
/// produced surprises like "info" for magic-link signups (info@example.de).
pub fn moderator_handle(m: &Moderator) -> String {
    match &m.username {
        Some(u) if !u.is_empty() => format!("@{u}"),
        _ => m.email.split('@').next().unwrap_or(&m.email).to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApproveOutcome {
    PrOpened { pr_url: String, pr_number: i64 },
    Approved { note: Option<String> },
    RejectedInvalidRegion { note: String },
    SkippedNoChange,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SubmissionRow {
    pub id: String,
    pub user_id: String,
    pub payload: String,
    pub status: String,
    pub pr_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ReportRow {
    pub id: String,
    pub kiosk_id: String,
    pub user_id: String,
    pub kind: String,
    pub payload: Option<String>,
    pub status: String,
    pub pr_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct KioskRow {
    pub id: String,
    pub region: String,
    pub name: String,
}

#[derive(serde::Deserialize)]
struct ProposedFeature {
    geometry: ProposedGeometry,
    properties: ProposedProperties,
}

#[derive(serde::Deserialize)]
struct ProposedGeometry {
    coordinates: [f64; 2],
}

#[derive(serde::Deserialize)]
struct ProposedProperties {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    address: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    hours: Option<serde_json::Value>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    payment: Option<serde_json::Value>,
}

// ── submissions ─────────────────────────────────────────────────────────────

pub async fn approve_submission(
    env: &worker::Env,
    submission: &SubmissionRow,
    moderator: &Moderator,
) -> Result<ApproveOutcome> {
    let feature: ProposedFeature = serde_json::from_str(&submission.payload)
        .map_err(|e| worker::Error::RustError(format!("submission payload: {e}")))?;
    let [lng, lat] = feature.geometry.coordinates;

    let Some(region) = resolve_region_by_coords(lng, lat) else {
        mark_submission(
            env,
            &submission.id,
            "dismissed",
            moderator,
            None,
            Some(
                "region not yet covered — coordinates outside any configured region in regions.yml",
            ),
        )
        .await?;
        return Ok(ApproveOutcome::RejectedInvalidRegion {
            note: "coordinates outside any covered region".into(),
        });
    };

    // Generate a stable ID using submission id (already random uuid) — eight
    // chars is collision-safe at our scale and keeps file IDs short.
    let short_id: String = submission
        .id
        .chars()
        .filter(|c| *c != '-')
        .take(8)
        .collect();
    let new_feature_id = format!("tk_{}_{}", region.prefix, short_id);
    let today = today();

    let mut properties = serde_json::Map::new();
    properties.insert("id".into(), new_feature_id.clone().into());
    properties.insert("name".into(), feature.properties.name.clone().into());
    if let Some(description) = feature
        .properties
        .description
        .as_deref()
        .filter(|d| !d.is_empty())
    {
        properties.insert("description".into(), description.into());
    }
    properties.insert(
        "address".into(),
        serde_json::Value::Object(feature.properties.address.clone().unwrap_or_default()),
    );
    if let Some(hours) = feature.properties.hours.clone() {
        properties.insert("hours".into(), hours);
    }
    if let Some(tags) = feature.properties.tags.clone().filter(|t| !t.is_empty()) {
        properties.insert("tags".into(), tags.into());
    }
    if let Some(payment) = feature.properties.payment.clone() {
        properties.insert("payment".into(), payment);
    }
    properties.insert(
        "sources".into(),
        serde_json::json!([{ "type": "user", "id": submission.user_id }]),
    );
    properties.insert("created".into(), today.clone().into());
    properties.insert("updated".into(), today.into());
    let final_feature = serde_json::json!({
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [feature.geometry.coordinates[0], feature.geometry.coordinates[1]],
        },
        "properties": properties,
    });

    if !has_github_app_creds(env) {
        mark_submission(env, &submission.id, "approved", moderator, None, None).await?;
        return Ok(ApproveOutcome::Approved {
            note: Some("approved in D1; PR not opened (GitHub App not configured)".into()),
        });
    }

    let commit_message = format!(
        "Add Späti \"{}\" ({new_feature_id})",
        feature.properties.name
    );
    let pr_title = format!("Add Späti \"{}\"", feature.properties.name);
    let pr_body = submission_pr_body(submission, &new_feature_id, moderator, &final_feature);
    let path = region.path;
    let branch = format!("prop/{short_id}");
    let pr = propose_change(
        env,
        path,
        &branch,
        &commit_message,
        &pr_title,
        &pr_body,
        |current| {
            append_feature_to_collection(current, &final_feature).map_err(worker::Error::RustError)
        },
    )
    .await?;

    let Some(pr) = pr else {
        mark_submission(
            env,
            &submission.id,
            "approved",
            moderator,
            None,
            Some("approved but proposeChange returned null (no diff)"),
        )
        .await?;
        return Ok(ApproveOutcome::SkippedNoChange);
    };

    mark_submission(
        env,
        &submission.id,
        "pr_opened",
        moderator,
        Some(&pr.html_url),
        None,
    )
    .await?;
    Ok(pr_opened(pr))
}

pub async fn reject_submission(
    env: &worker::Env,
    submission: &SubmissionRow,
    moderator: &Moderator,
    note: Option<&str>,
) -> Result<()> {
    mark_submission(env, &submission.id, "dismissed", moderator, None, note).await
}

async fn mark_submission(
    env: &worker::Env,
    id: &str,
    status: &str,
    moderator: &Moderator,
    pr_url: Option<&str>,
    note: Option<&str>,
) -> Result<()> {
    mark_row(env, "submissions", id, status, moderator, pr_url, note).await
}

// ── reports ─────────────────────────────────────────────────────────────────

pub async fn approve_report(
    env: &worker::Env,
    report: &ReportRow,
    kiosk: &KioskRow,
    moderator: &Moderator,
) -> Result<ApproveOutcome> {
    let payload: serde_json::Value = match report.payload.as_deref() {
        Some(p) => serde_json::from_str(p).unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    };

    // Reports whose change can't be encoded as a structured patch open an
    // ISSUE on the data repo (moderator triages manually).
    if report.kind == "duplicate" || report.kind == "other" {
        return open_report_as_issue(env, report, kiosk, moderator, &payload).await;
    }

    // Map the kiosk's stored region slug back to a Region entry. `kiosk.region`
    // is a slug (set when the asset kiosk was materialised), so lookup is by
    // *slug* — by *path* never matched and every report fell through to an
    // issue instead of a PR.
    let Some(region) = resolve_region_by_slug(&kiosk.region) else {
        return open_report_as_issue(env, report, kiosk, moderator, &payload).await;
    };

    if !has_github_app_creds(env) {
        mark_report(env, &report.id, "approved", moderator, None, None).await?;
        return Ok(ApproveOutcome::Approved {
            note: Some("approved in D1; PR not opened (GitHub App not configured)".into()),
        });
    }

    let short_id: String = report.id.chars().filter(|c| *c != '-').take(8).collect();
    let branch = format!("fix/{short_id}");
    let commit_message = commit_message_for_report(&report.kind, &kiosk.name);
    let pr_body = report_pr_body(report, kiosk, moderator, &payload);
    let kiosk_id = kiosk.id.clone();
    let kind = report.kind.clone();
    let patch_payload = payload.clone();
    let proposed = propose_change(
        env,
        region.path,
        &branch,
        &commit_message,
        &commit_message,
        &pr_body,
        |current| {
            apply_report_patch(current, &kiosk_id, &kind, &patch_payload)
                .map_err(worker::Error::RustError)
        },
    )
    .await;

    let pr = match proposed {
        Ok(pr) => pr,
        Err(e) => {
            // The feature may have been removed, renumbered, or restructured in
            // the data repo since the app was last deployed (OSM scrape,
            // enrichment run, merged PR). Fall back to an issue so the
            // moderator can triage manually instead of a hard error.
            let msg = e.to_string();
            if !msg.contains("not found in file") {
                return Err(e);
            }
            let mut with_note = payload.clone();
            with_note["_auto_note"] = format!("Structured patch failed: {msg}").into();
            return open_report_as_issue(env, report, kiosk, moderator, &with_note).await;
        }
    };

    let Some(pr) = pr else {
        mark_report(
            env,
            &report.id,
            "approved",
            moderator,
            None,
            Some("approved but proposeChange returned null (no diff)"),
        )
        .await?;
        return Ok(ApproveOutcome::SkippedNoChange);
    };

    mark_report(
        env,
        &report.id,
        "pr_opened",
        moderator,
        Some(&pr.html_url),
        None,
    )
    .await?;
    Ok(pr_opened(pr))
}

pub async fn reject_report(
    env: &worker::Env,
    report: &ReportRow,
    moderator: &Moderator,
    note: Option<&str>,
) -> Result<()> {
    mark_row(
        env,
        "reports",
        &report.id,
        "dismissed",
        moderator,
        None,
        note,
    )
    .await
}

async fn open_report_as_issue(
    env: &worker::Env,
    report: &ReportRow,
    kiosk: &KioskRow,
    moderator: &Moderator,
    payload: &serde_json::Value,
) -> Result<ApproveOutcome> {
    if !has_github_app_creds(env) {
        mark_report(
            env,
            &report.id,
            "approved",
            moderator,
            None,
            Some("approved in D1 (no GitHub App); would have opened issue"),
        )
        .await?;
        return Ok(ApproveOutcome::Approved { note: None });
    }
    let title = format!("[{}] {} ({})", report.kind, kiosk.name, kiosk.id);
    let body = report_issue_body(report, kiosk, moderator, payload);
    let labels = vec!["report".to_owned(), report.kind.clone()];
    let Some(issue) = open_issue_via_pr(env, &title, &body, Some(&labels)).await? else {
        mark_report(
            env,
            &report.id,
            "approved",
            moderator,
            None,
            Some("issue creation failed; flagged as approved"),
        )
        .await?;
        return Ok(ApproveOutcome::Approved { note: None });
    };
    mark_report(
        env,
        &report.id,
        "pr_opened",
        moderator,
        Some(&issue.html_url),
        None,
    )
    .await?;
    Ok(pr_opened(issue))
}

async fn mark_report(
    env: &worker::Env,
    id: &str,
    status: &str,
    moderator: &Moderator,
    pr_url: Option<&str>,
    note: Option<&str>,
) -> Result<()> {
    mark_row(env, "reports", id, status, moderator, pr_url, note).await
}

async fn mark_row(
    env: &worker::Env,
    table: &str,
    id: &str,
    status: &str,
    moderator: &Moderator,
    pr_url: Option<&str>,
    note: Option<&str>,
) -> Result<()> {
    let now = unix_now();
    let db = env.d1("DB")?;
    let sql = format!(
        "UPDATE {table} SET
         status = ?,
         pr_url = COALESCE(?, pr_url),
         approved_by = ?,
         approved_at = ?,
         moderator_note = ?,
         updated_at = ?
       WHERE id = ?"
    );
    db.prepare(sql)
        .bind(&[
            wasm_bindgen::JsValue::from_str(status),
            opt_js(pr_url),
            wasm_bindgen::JsValue::from_str(&moderator.id),
            wasm_bindgen::JsValue::from_f64(now as f64),
            opt_js(note),
            wasm_bindgen::JsValue::from_f64(now as f64),
            wasm_bindgen::JsValue::from_str(id),
        ])?
        .run()
        .await?;
    Ok(())
}

fn opt_js(v: Option<&str>) -> wasm_bindgen::JsValue {
    match v {
        Some(s) => wasm_bindgen::JsValue::from_str(s),
        None => wasm_bindgen::JsValue::NULL,
    }
}

fn pr_opened(pr: CreatedPr) -> ApproveOutcome {
    ApproveOutcome::PrOpened {
        pr_url: pr.html_url,
        pr_number: pr.number,
    }
}

// ── reconciliation ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub merged: u32,
    pub dismissed: u32,
}

impl Tally {
    pub fn record(&mut self, outcome: UpstreamOutcome) {
        match outcome {
            UpstreamOutcome::Merged => self.merged += 1,
            UpstreamOutcome::Dismissed => self.dismissed += 1,
        }
    }
}

/// The three statements reconciliation needs. A trait so the queue-rotation
/// behaviour (plans/003) can be pinned by tests against a fake.
pub trait ReconcileDb {
    fn select_open(
        &mut self,
        table: &'static str,
    ) -> impl Future<Output = Result<Vec<(String, String)>>>;
    fn touch(
        &mut self,
        table: &'static str,
        id: &str,
        now: i64,
    ) -> impl Future<Output = Result<()>>;
    fn set_status(
        &mut self,
        table: &'static str,
        id: &str,
        status: &str,
        now: i64,
    ) -> impl Future<Output = Result<()>>;
}

pub struct D1ReconcileDb<'a>(pub &'a D1Database);

impl ReconcileDb for D1ReconcileDb<'_> {
    async fn select_open(&mut self, table: &'static str) -> Result<Vec<(String, String)>> {
        // `status = ?` is a bound parameter on purpose: a bare `pr_opened`
        // identifier is a column reference to SQLite and D1 throws
        // "no such column: pr_opened".
        let sql = format!(
            "SELECT id, pr_url FROM {table} WHERE status = ? AND pr_url IS NOT NULL ORDER BY updated_at ASC LIMIT 50"
        );
        #[derive(serde::Deserialize)]
        struct Row {
            id: String,
            pr_url: String,
        }
        let rows: Vec<Row> = self
            .0
            .prepare(sql)
            .bind(&[wasm_bindgen::JsValue::from_str("pr_opened")])?
            .all()
            .await?
            .results()?;
        Ok(rows.into_iter().map(|r| (r.id, r.pr_url)).collect())
    }

    async fn touch(&mut self, table: &'static str, id: &str, now: i64) -> Result<()> {
        let sql = format!("UPDATE {table} SET updated_at = ? WHERE id = ?");
        self.0
            .prepare(sql)
            .bind(&[
                wasm_bindgen::JsValue::from_f64(now as f64),
                wasm_bindgen::JsValue::from_str(id),
            ])?
            .run()
            .await?;
        Ok(())
    }

    async fn set_status(
        &mut self,
        table: &'static str,
        id: &str,
        status: &str,
        now: i64,
    ) -> Result<()> {
        let sql = format!("UPDATE {table} SET status = ?, updated_at = ? WHERE id = ?");
        self.0
            .prepare(sql)
            .bind(&[
                wasm_bindgen::JsValue::from_str(status),
                wasm_bindgen::JsValue::from_f64(now as f64),
                wasm_bindgen::JsValue::from_str(id),
            ])?
            .run()
            .await?;
        Ok(())
    }
}

/// Bring `pr_opened` rows in line with what actually happened upstream.
///
/// Approval hands off to GitHub and nothing observed the PR being merged or
/// the issue closed, so rows sat at `pr_opened` forever. That is not just a
/// stale label — `pr_opened` is a blocking status (core `BLOCKING_STATUSES`),
/// so the reporter stayed locked out of filing that kind again for that
/// kiosk. Runs on a cron rather than a webhook on purpose: no new inbound
/// surface to authenticate, and it reuses the App token we already hold.
///
/// Rows whose lookup fails or is still open have their `updated_at` advanced
/// so they move to the back of the queue (plans/003): without that touch,
/// unresolved rows hold the head of the `updated_at ASC` ordering and starve
/// everything behind them.
pub async fn reconcile_open_with<D, F, Fut>(
    db: &mut D,
    table: &'static str,
    mut fetch_outcome: F,
) -> Result<Tally>
where
    D: ReconcileDb,
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Option<UpstreamOutcome>>,
{
    let mut tally = Tally::default();
    let rows = db.select_open(table).await?;
    let now = unix_now();
    for (id, pr_url) in rows {
        match fetch_outcome(pr_url).await {
            None => db.touch(table, &id, now).await?,
            Some(outcome) => {
                db.set_status(table, &id, outcome.as_status(), now).await?;
                tally.record(outcome);
            }
        }
    }
    Ok(tally)
}

pub async fn reconcile_open_reports(env: &worker::Env) -> Result<Tally> {
    let mut db = D1ReconcileDb(&env.d1("DB")?);
    reconcile_open(env, &mut db, "reports").await
}

pub async fn reconcile_open_submissions(env: &worker::Env) -> Result<Tally> {
    let mut db = D1ReconcileDb(&env.d1("DB")?);
    reconcile_open(env, &mut db, "submissions").await
}

async fn reconcile_open<D: ReconcileDb>(
    env: &worker::Env,
    db: &mut D,
    table: &'static str,
) -> Result<Tally> {
    if !has_github_app_creds(env) {
        return Ok(Tally::default());
    }
    reconcile_open_with(db, table, |pr_url| async move {
        match fetch_upstream_outcome(env, &pr_url).await {
            Ok(outcome) => outcome,
            // Lookup failures are "no decision yet": the row rotates to the
            // back of the queue instead of blocking it for good.
            Err(e) => {
                worker::console_error!("fetchUpstreamOutcome({pr_url}) failed: {e}");
                None
            }
        }
    })
    .await
}

// ── PR / issue bodies ───────────────────────────────────────────────────────

fn submission_pr_body(
    submission: &SubmissionRow,
    feature_id: &str,
    moderator: &Moderator,
    feature: &serde_json::Value,
) -> String {
    [
        format!("**Vorschlag**: `{}` → `{feature_id}`", submission.id),
        format!("**Approved by**: {}", moderator_handle(moderator)),
        String::new(),
        "Auto-generated by trinkhallen.app moderation. Merge to publish.".to_owned(),
        String::new(),
        "<details><summary>Proposed Feature</summary>".to_owned(),
        String::new(),
        "```json".to_owned(),
        serde_json::to_string_pretty(feature).unwrap_or_default(),
        "```".to_owned(),
        String::new(),
        "</details>".to_owned(),
    ]
    .join("\n")
}

fn report_pr_body(
    report: &ReportRow,
    kiosk: &KioskRow,
    moderator: &Moderator,
    payload: &serde_json::Value,
) -> String {
    [
        format!("**Report**: `{}` (kind `{}`)", report.id, report.kind),
        format!(
            "**Kiosk**: [{}]({APP_ORIGIN}/k/{}) — `{}`",
            kiosk.name, kiosk.id, kiosk.id
        ),
        format!("**Approved by**: {}", moderator_handle(moderator)),
        String::new(),
        "<details><summary>User-supplied payload</summary>".to_owned(),
        String::new(),
        "```json".to_owned(),
        serde_json::to_string_pretty(payload).unwrap_or_default(),
        "```".to_owned(),
        String::new(),
        "</details>".to_owned(),
    ]
    .join("\n")
}

fn report_issue_body(
    report: &ReportRow,
    kiosk: &KioskRow,
    moderator: &Moderator,
    payload: &serde_json::Value,
) -> String {
    [
        format!(
            "**Report kind**: `{}` (auto-PR not applicable)",
            report.kind
        ),
        format!(
            "**Kiosk**: [{}]({APP_ORIGIN}/k/{}) — `{}`",
            kiosk.name, kiosk.id, kiosk.id
        ),
        format!("**Approved by**: {}", moderator_handle(moderator)),
        String::new(),
        "Moderator action: investigate and edit the relevant data file by hand.".to_owned(),
        String::new(),
        "**User payload**".to_owned(),
        "```json".to_owned(),
        serde_json::to_string_pretty(payload).unwrap_or_default(),
        "```".to_owned(),
    ]
    .join("\n")
}

fn commit_message_for_report(kind: &str, name: &str) -> String {
    match kind {
        "wrong_hours" => format!("Fix opening hours for {name}"),
        "wrong_address" => format!("Fix address for {name}"),
        "wrong_name" => format!("Fix name for {name}"),
        "closed" => format!("Delete {name} (permanently closed)"),
        "update_payment" => format!("Fill in payment methods for {name}"),
        "update_tags" => format!("Update amenity tags for {name}"),
        "ph_open_observed" => format!("Mark {name} as open on public holidays"),
        other => format!("Update {name} ({other})"),
    }
}

/// The kiosk a report targets, including the synthetic fallback for kiosks
/// that left the dataset since the report was filed (OSM scrape, data repo
/// restructure) — a moderator can still approve → issue instead of hitting a
/// dead-end 404.
pub fn synthetic_kiosk_row(kiosk_id: &str) -> KioskRow {
    let region = parse_prefix(kiosk_id)
        .and_then(resolve_region_by_prefix)
        .map(|r| r.slug)
        .unwrap_or("");
    KioskRow {
        id: kiosk_id.to_owned(),
        region: region.to_owned(),
        name: kiosk_id.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moderator_handle_prefers_username_then_email_local_part() {
        let m = Moderator {
            id: "m".into(),
            username: Some("jonas_s".into()),
            email: "a@b.de".into(),
        };
        assert_eq!(moderator_handle(&m), "@jonas_s");
        let m = Moderator {
            id: "m".into(),
            username: None,
            email: "info@example.de".into(),
        };
        assert_eq!(moderator_handle(&m), "info");
    }

    #[test]
    fn commit_messages_per_kind() {
        assert_eq!(
            commit_message_for_report("wrong_hours", "X"),
            "Fix opening hours for X"
        );
        assert_eq!(
            commit_message_for_report("closed", "X"),
            "Delete X (permanently closed)"
        );
        assert_eq!(
            commit_message_for_report("ph_open_observed", "X"),
            "Mark X as open on public holidays"
        );
        assert_eq!(
            commit_message_for_report("made_up", "X"),
            "Update X (made_up)"
        );
    }

    #[test]
    fn synthetic_row_uses_the_generated_region_table() {
        let row = synthetic_kiosk_row("tk_fr_0042");
        assert_eq!(row.region, "frankfurt");
        assert_eq!(row.name, "tk_fr_0042");
        assert_eq!(synthetic_kiosk_row("tk_zzz_1").region, "");
    }

    #[test]
    fn pr_body_rendering() {
        let report = ReportRow {
            id: "r-1".into(),
            kiosk_id: "tk_fr_0042".into(),
            user_id: "u".into(),
            kind: "wrong_hours".into(),
            payload: Some(r#"{"new_hours":"24/7"}"#.into()),
            status: "open".into(),
            pr_url: None,
            created_at: 0,
        };
        let kiosk = KioskRow {
            id: "tk_fr_0042".into(),
            region: "frankfurt".into(),
            name: "Eichenloh".into(),
        };
        let m = Moderator {
            id: "m".into(),
            username: Some("mod".into()),
            email: "a@b.de".into(),
        };
        let body = report_pr_body(
            &report,
            &kiosk,
            &m,
            &serde_json::json!({"new_hours":"24/7"}),
        );
        assert!(body.contains("**Approved by**: @mod"));
        assert!(body.contains("trinkhallen.app/k/tk_fr_0042"));
        assert!(body.contains("24/7"));
    }

    // ── reconciliation against a fake DB (plans/003 rotation) ──────────────

    /// Poll a ready future once with a no-op waker — enough for the fake DB
    /// and fake fetch here, and no executor dependency.
    fn run<F: Future>(fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

        fn clone(_: *const ()) -> RawWaker {
            raw()
        }
        fn noop(_: *const ()) {}
        fn raw() -> RawWaker {
            static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
            RawWaker::new(std::ptr::null(), &VTABLE)
        }

        // Safety: the waker does nothing and never dereferences its data.
        let waker = unsafe { Waker::from_raw(raw()) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = std::pin::pin!(fut);
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("test future never awaits"),
        }
    }

    #[derive(Default)]
    struct FakeDb {
        rows: Vec<(String, String)>,
        touched: Vec<String>,
        transitions: Vec<(String, String)>,
    }

    impl ReconcileDb for FakeDb {
        async fn select_open(&mut self, _table: &'static str) -> Result<Vec<(String, String)>> {
            Ok(std::mem::take(&mut self.rows))
        }
        async fn touch(&mut self, _table: &'static str, id: &str, _now: i64) -> Result<()> {
            self.touched.push(id.to_owned());
            Ok(())
        }
        async fn set_status(
            &mut self,
            _table: &'static str,
            id: &str,
            status: &str,
            _now: i64,
        ) -> Result<()> {
            self.transitions.push((id.to_owned(), status.to_owned()));
            Ok(())
        }
    }

    #[test]
    fn merged_rows_transition_and_do_not_rotate() {
        let mut db = FakeDb {
            rows: vec![("r-1".into(), "https://github.com/x/y/pull/7".into())],
            ..Default::default()
        };
        let out = run(reconcile_open_with(&mut db, "reports", |_url| async {
            Some(UpstreamOutcome::Merged)
        }))
        .unwrap();
        assert_eq!(
            out,
            Tally {
                merged: 1,
                dismissed: 0
            }
        );
        assert_eq!(db.transitions, vec![("r-1".into(), "merged".into())]);
        assert!(db.touched.is_empty());
    }

    #[test]
    fn a_closed_pr_without_merge_records_dismissed() {
        let mut db = FakeDb {
            rows: vec![("r-2".into(), "https://github.com/x/y/pull/8".into())],
            ..Default::default()
        };
        let out = run(reconcile_open_with(&mut db, "reports", |_url| async {
            Some(UpstreamOutcome::Dismissed)
        }))
        .unwrap();
        assert_eq!(
            out,
            Tally {
                merged: 0,
                dismissed: 1
            }
        );
        assert_eq!(db.transitions, vec![("r-2".into(), "dismissed".into())]);
    }

    #[test]
    fn still_open_rows_never_get_a_status_but_rotate() {
        let mut db = FakeDb {
            rows: vec![("r-3".into(), "https://github.com/x/y/pull/9".into())],
            ..Default::default()
        };
        let out = run(reconcile_open_with(&mut db, "reports", |_url| async {
            None
        }))
        .unwrap();
        assert_eq!(
            out,
            Tally {
                merged: 0,
                dismissed: 0
            }
        );
        assert!(db.transitions.is_empty(), "no status may be guessed");
        assert_eq!(
            db.touched,
            vec!["r-3".to_owned()],
            "updated_at advances so the next run reaches other rows"
        );
    }

    #[test]
    fn a_mixed_batch_rotates_and_transitions_independently() {
        let mut db = FakeDb {
            rows: vec![
                ("r-5".into(), "https://github.com/x/y/pull/12".into()),
                ("r-6".into(), "https://github.com/x/y/pull/13".into()),
            ],
            ..Default::default()
        };
        let out = run(reconcile_open_with(&mut db, "reports", |url| {
            let open = url.ends_with("/12");
            async move {
                if open {
                    None
                } else {
                    Some(UpstreamOutcome::Merged)
                }
            }
        }))
        .unwrap();
        assert_eq!(
            out,
            Tally {
                merged: 1,
                dismissed: 0
            }
        );
        assert_eq!(db.touched, vec!["r-5".to_owned()]);
        assert_eq!(db.transitions, vec![("r-6".into(), "merged".into())]);
    }
}
