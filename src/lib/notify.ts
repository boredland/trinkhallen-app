/**
 * Operator ping when a new report lands in the moderation queue.
 *
 * Fire-and-forget by design: a reporting user's POST must never fail, stall,
 * or roll back because the mail hop is slow or Email Routing is misconfigured.
 * The D1 insert is the source of truth; the mail is a convenience nudge to go
 * look at /moderate.
 *
 * `REPORT_NOTIFY_TO` must be a **verified Email Routing destination address**
 * on the account — the `send_email` binding rejects anything else with
 * `E_RECIPIENT_NOT_ALLOWED`. Unset disables notifications entirely.
 */

import type { Env } from "../env";
import { type EmailPayload, sendEmail } from "./email";
import { kindLabel } from "./reports";

export interface ReportNotification {
  id: string;
  kioskId: string;
  kioskName: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Display handle for the reporter — `@username` or the email local-part. */
  reporter: string;
}

export function notifyNewReport(env: Env, ctx: ExecutionContext, report: ReportNotification): void {
  if (!env.REPORT_NOTIFY_TO) return;

  ctx.waitUntil(
    sendEmail(env, buildReportEmail(env, report)).catch((err) => {
      console.error("report notification send failed", report.id, err);
    }),
  );
}

/**
 * Composes the operator mail. German throughout — this goes to the moderator,
 * not to the reporter, and matches the tone of the magic-link mail.
 *
 * The payload is dumped verbatim rather than pretty-printed per kind: the
 * moderation UI already renders the rich per-kind view, and a raw dump can't
 * silently go stale when a new report kind lands.
 */
export function buildReportEmail(
  env: Pick<Env, "PUBLIC_ORIGIN" | "REPORT_NOTIFY_TO">,
  report: ReportNotification,
): EmailPayload {
  const kind = kindLabel("de", report.kind);
  const moderateUrl = `${env.PUBLIC_ORIGIN}/moderate?tab=reports`;
  const kioskUrl = `${env.PUBLIC_ORIGIN}/k/${report.kioskId}`;
  const note = typeof report.payload["note"] === "string" ? report.payload["note"] : null;
  const details = JSON.stringify(report.payload, null, 2);

  const text = [
    `Neue Meldung für ${report.kioskName}.`,
    "",
    `Art:    ${kind}`,
    `Von:    ${report.reporter}`,
    ...(note ? [`Notiz:  ${note}`] : []),
    "",
    details,
    "",
    `Moderieren: ${moderateUrl}`,
    `Späti:      ${kioskUrl}`,
    "",
    "— trinkhallen.app",
  ].join("\r\n");

  const html =
    `<p>Neue Meldung für <strong>${escapeHtml(report.kioskName)}</strong>.</p>` +
    `<p>Art: <strong>${escapeHtml(kind)}</strong><br>Von: ${escapeHtml(report.reporter)}</p>` +
    (note
      ? `<blockquote style="border-left:3px solid #FF2D6F;margin:0 0 1em;padding-left:.8em;color:#444">${escapeHtml(note)}</blockquote>`
      : "") +
    `<pre style="background:#f4f4f4;padding:.8em;overflow-x:auto;font-size:.85em">${escapeHtml(details)}</pre>` +
    `<p><a href="${moderateUrl}" style="display:inline-block;padding:.6rem 1rem;background:#FF2D6F;color:#0A0A0A;font-family:Anton,sans-serif;letter-spacing:.05em;text-decoration:none">▶ Moderieren</a></p>` +
    `<p style="color:#999;font-size:0.85em"><a href="${kioskUrl}">${escapeHtml(report.kioskName)}</a> · trinkhallen.app</p>`;

  return {
    to: env.REPORT_NOTIFY_TO,
    subject: `Neue Meldung: ${kind} — ${report.kioskName}`,
    text,
    html,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
