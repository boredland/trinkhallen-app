import type { Env } from "../env";
import { type Lang, REPORT_KIND_LABELS, REPORT_STATUS_LABELS } from "./messages";

/**
 * Reports a user has submitted for one kiosk that are still "live" — either
 * waiting for moderation or already accepted. Used to block re-submission of
 * the same kind by the same user, and to render a "you already reported X"
 * panel on the kiosk detail page.
 *
 * Dismissed / auto-rejected rows are intentionally excluded: a rejection is
 * the moderator saying "this isn't right" — the user can try again.
 */

export interface UserKioskReport {
  id: string;
  kind: string;
  status: string;
  pr_url: string | null;
  created_at: number;
}

const BLOCKING_STATUSES = ["open", "pr_opened", "approved"] as const;

export async function getUserReports(
  env: Env,
  kioskId: string,
  userId: string,
): Promise<UserKioskReport[]> {
  const placeholders = BLOCKING_STATUSES.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT id, kind, status, pr_url, created_at
       FROM reports
       WHERE kiosk_id = ? AND user_id = ?
         AND status IN (${placeholders})
       ORDER BY created_at DESC`,
  )
    .bind(kioskId, userId, ...BLOCKING_STATUSES)
    .all<UserKioskReport>();
  return res.results;
}

export async function hasBlockingReport(
  env: Env,
  kioskId: string,
  userId: string,
  kind: string,
): Promise<boolean> {
  const placeholders = BLOCKING_STATUSES.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT 1 AS n FROM reports
       WHERE kiosk_id = ? AND user_id = ? AND kind = ?
         AND status IN (${placeholders})
       LIMIT 1`,
  )
    .bind(kioskId, userId, kind, ...BLOCKING_STATUSES)
    .first<{ n: number }>();
  return row !== null;
}

export function kindLabel(lang: Lang, kind: string): string {
  return REPORT_KIND_LABELS[lang][kind] ?? kind;
}

export function statusLabel(lang: Lang, status: string): string {
  // `approved`/`pr_opened` deliberately collapse to one label — we don't
  // expose the PR mechanism to end users (see REPORT_STATUS_LABELS).
  return REPORT_STATUS_LABELS[lang][status] ?? status;
}
