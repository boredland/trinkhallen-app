//! Operator ping when a new report lands in the moderation queue (composed
//! as a plain-text email).
//!
//! Fire-and-forget by design: a reporting user's POST must never fail, stall
//! or roll back because the mail hop is slow or Email Routing is
//! misconfigured. The D1 insert is the source of truth; the mail is a
//! convenience nudge to go look at `/moderate`.
//!
//! `REPORT_NOTIFY_TO` must be a verified Email Routing destination address on
//! the account — the binding rejects anything else with
//! `E_RECIPIENT_NOT_ALLOWED`. Unset disables notifications entirely.

use worker::{Context, Env};

use crate::email::{self, FROM_ADDRESS, FROM_NAME};
use crate::util;

pub struct ReportNotification {
    pub id: String,
    pub kiosk_id: String,
    pub kiosk_name: String,
    pub kind: String,
    pub payload: serde_json::Value,
    /// Display handle for the reporter — `@username` or the email address.
    pub reporter: String,
}

pub fn notify_new_report(env: &Env, ctx: &Context, report: ReportNotification) {
    let Some(to) = util::env_str(env, "REPORT_NOTIFY_TO") else {
        return;
    };
    let origin =
        util::env_str(env, "PUBLIC_ORIGIN").unwrap_or_else(|| trinkhallen_core::ORIGIN.to_owned());
    let mail = build_report_email(&origin, &to, &report);
    let send_env = env.clone();
    ctx.wait_until(async move {
        if let Err(err) = email::send(&send_env, &mail.0, &mail.1, &mail.2, Some(&mail.3)).await {
            worker::console_error!("report notification send failed {} {err}", report.id);
        }
    });
}

/// Composes the operator mail. German throughout — this goes to the
/// moderator, not to the reporter, and matches the tone of the magic-link
/// mail. The payload is dumped verbatim rather than pretty-printed per kind:
/// the moderation UI already renders the rich per-kind view, and a raw dump
/// can't silently go stale when a new report kind lands.
///
/// Returns `(to, subject, text, html)`.
pub fn build_report_email(
    origin: &str,
    to: &str,
    report: &ReportNotification,
) -> (String, String, String, String) {
    let kind = trinkhallen_core::i18n::report_kind_label(trinkhallen_core::Lang::De, &report.kind);
    let moderate_url = format!("{origin}/moderate?tab=reports");
    let kiosk_url = format!("{origin}/k/{}", report.kiosk_id);
    let note = report.payload.get("note").and_then(|n| n.as_str());
    let details = serde_json::to_string_pretty(&report.payload).unwrap_or_default();

    let mut text = format!(
        "Neue Meldung für {}.\r\n\r\nArt:    {}\r\nVon:    {}\r\n",
        report.kiosk_name, kind, report.reporter
    );
    if let Some(note) = note {
        text.push_str(&format!("Notiz:  {note}\r\n"));
    }
    text.push_str(&format!(
        "\r\n{details}\r\n\r\nModerieren: {moderate_url}\r\nSpäti:      {kiosk_url}\r\n\r\n— trinkhallen.app"
    ));

    let mut html = format!(
        "<p>Neue Meldung für <strong>{}</strong>.</p><p>Art: <strong>{}</strong><br>Von: {}</p>",
        escape_html(&report.kiosk_name),
        escape_html(&kind),
        escape_html(&report.reporter)
    );
    if let Some(note) = note {
        html.push_str(&format!(
            "<blockquote style=\"border-left:3px solid #FF2D6F;margin:0 0 1em;padding-left:.8em;color:#444\">{}</blockquote>",
            escape_html(note)
        ));
    }
    html.push_str(&format!(
        "<pre style=\"background:#f4f4f4;padding:.8em;overflow-x:auto;font-size:.85em\">{}</pre>",
        escape_html(&details)
    ));
    html.push_str(&format!(
        "<p><a href=\"{moderate_url}\" style=\"display:inline-block;padding:.6rem 1rem;background:#FF2D6F;color:#0A0A0A;font-family:Anton,sans-serif;letter-spacing:.05em;text-decoration:none\">▶ Moderieren</a></p>"
    ));
    html.push_str(&format!(
        "<p style=\"color:#999;font-size:0.85em\"><a href=\"{kiosk_url}\">{}</a> · trinkhallen.app</p>",
        escape_html(&report.kiosk_name)
    ));

    (
        to.to_owned(),
        format!("Neue Meldung: {kind} — {}", report.kiosk_name),
        text,
        html,
    )
}

/// Magic-link and notification mail share the plain-text-first rule.
pub fn from_address() -> (&'static str, &'static str) {
    (FROM_NAME, FROM_ADDRESS)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_email_layout_matches_the_ts_mail() {
        let report = ReportNotification {
            id: "r1".into(),
            kiosk_id: "tk_fr_osm_1".into(),
            kiosk_name: "Kiosk <Am> & Co".into(),
            kind: "wrong_hours".into(),
            payload: serde_json::json!({ "note": "zu", "new_hours": "Mo-Fr 09:00-22:00" }),
            reporter: "@pfand_pirat_42".into(),
        };
        let (to, subject, text, html) =
            build_report_email("https://trinkhallen.app", "ops@example.com", &report);
        assert_eq!(to, "ops@example.com");
        assert_eq!(subject, "Neue Meldung: Öffnungszeiten — Kiosk <Am> & Co");
        assert!(text.starts_with("Neue Meldung für Kiosk <Am> & Co."));
        assert!(text.contains("Notiz:  zu"));
        assert!(text.contains("Moderieren: https://trinkhallen.app/moderate?tab=reports"));
        assert!(text.contains("\r\n"));
        assert!(html.contains("Kiosk &lt;Am&gt; &amp; Co"));
        assert!(!html.contains("<Am>"));
        assert!(html.contains("▶ Moderieren"));
    }
}
