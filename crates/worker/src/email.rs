//! Outbound email via Cloudflare Email Service (`send_email` binding).
//!
//! The binding takes a structured message and builds the MIME itself, so
//! there is no hand-rolled RFC 2822 composition here. Always send `text`
//! alongside `html`: some clients only render plain text, and a missing text
//! part hurts spam scoring.

use worker::{EmailAddress, Env, Result, SendEmailBuilder};

/// The `from` domain (trinkhallen.app) is onboarded for Email Sending;
/// sending from a domain that is not onboarded throws `E_SENDER_NOT_VERIFIED`.
pub const FROM_ADDRESS: &str = "feedback@trinkhallen.app";
pub const FROM_NAME: &str = "trinkhallen.app";

/// Fire-and-forget through `ctx.wait_until` at the call sites — a user's POST
/// must never fail or stall because the mail hop is slow.
pub async fn send(
    env: &Env,
    to: &str,
    subject: &str,
    text: &str,
    html: Option<&str>,
) -> Result<()> {
    let from = EmailAddress::new(FROM_NAME, FROM_ADDRESS);
    let mut builder =
        SendEmailBuilder::builder_with_email_address_and_str(&from, to, subject).text(text);
    if let Some(html) = html {
        builder = builder.html(html);
    }
    env.send_email("EMAIL")?
        .send_with_builder(&builder.build())
        .await?;
    Ok(())
}
