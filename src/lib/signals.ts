/**
 * Per-field signal log — Phase 0 of the Frische epic (#5, carved out as #7).
 *
 * `recordSignal` is the strict write-path: it runs every incoming
 * confirm/dispute/fill through `verifyPresence` (from #4) and rejects anything
 * without a fresh in-range fix. There is intentionally no remote/unverified
 * path yet — only verified signals enter the log, so downstream phases
 * (confidence, consensus, scoring) start with clean data.
 *
 * Same-day re-confirms are silent no-ops via the UNIQUE
 * (user, kiosk, field_key, day) index — `INSERT OR IGNORE` reports
 * `inserted: false` rather than throwing.
 */

import type { Env } from "../env";
import { type VerifyReason, verifyPresence } from "./checkins";

export type SignalAction = "confirm" | "dispute" | "fill";

export interface RecordSignalInput {
  kioskId: string;
  kioskLat: number;
  kioskLng: number;
  regionSlug: string;
  userId: string;
  fieldKey: string;
  action: SignalAction;
  /** Only used for `dispute` / `fill`; ignored on `confirm`. */
  assertedValue?: string | null;
  userLat?: number;
  userLng?: number;
  accuracy?: number;
}

export type RecordSignalResult =
  | { ok: true; inserted: boolean; signalId: string }
  | { ok: false; reason: VerifyReason };

export async function recordSignal(
  env: Env,
  input: RecordSignalInput,
): Promise<RecordSignalResult> {
  const presence = verifyPresence({
    kioskLat: input.kioskLat,
    kioskLng: input.kioskLng,
    userLat: input.userLat,
    userLng: input.userLng,
    accuracy: input.accuracy,
  });
  if (!presence.verified) return { ok: false, reason: presence.reason };

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const assertedValue = input.action === "confirm" ? null : (input.assertedValue ?? null);

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO field_signals
       (id, kiosk_id, field_key, action, asserted_value, user_id, verified, region_slug, created_at, created_day)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(
      id,
      input.kioskId,
      input.fieldKey,
      input.action,
      assertedValue,
      input.userId,
      input.regionSlug,
      now,
      day,
    )
    .run();

  return { ok: true, inserted: (result.meta?.changes ?? 0) > 0, signalId: id };
}
