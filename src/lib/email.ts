/**
 * Outbound email via Cloudflare Email Service (the `send_email` binding).
 *
 * `env.EMAIL.send()` takes a structured message — Email Service builds the
 * MIME itself, so there is no hand-rolled RFC 2822 composition here and no
 * `cloudflare:email` import. Always send `text` alongside `html`: some clients
 * only render plain text, and a missing text part hurts spam scoring.
 *
 * The `from` domain (trinkhallen.app) is onboarded for Email Sending. Sending
 * from a domain that is not onboarded throws `E_SENDER_NOT_VERIFIED`.
 */

import type { Env } from "../env";

export const FROM_ADDRESS = "feedback@trinkhallen.app";
export const FROM_NAME = "trinkhallen.app";

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(env: Env, msg: EmailPayload): Promise<void> {
  await env.EMAIL.send({
    to: msg.to,
    from: { email: FROM_ADDRESS, name: FROM_NAME },
    subject: msg.subject,
    text: msg.text,
    ...(msg.html ? { html: msg.html } : {}),
  });
}
