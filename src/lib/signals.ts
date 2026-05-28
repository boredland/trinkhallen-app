/**
 * Per-field signal log — Phase 0 of the Frische epic (#5, carved out as #7).
 *
 * `recordSignal` **always records** the signal; the `verified` column captures
 * whether the user had a fresh in-range fix at the kiosk (via `verifyPresence`
 * from #4):
 *   verified = 1 → high-confidence: the strict accuracy-aware fence passed.
 *   verified = 0 → low-confidence: no fix, out of range, or low-accuracy fix.
 *
 * Decoupling the *capture* (always record) from the *gate* (verifyPresence
 * remains strict) means later phases can weight verified=1 heavily, drop
 * verified=0 from scoring/leaderboards, or treat them as weak signals for the
 * confidence overlay — without losing the data in the meantime. Daily dedup
 * via the UNIQUE (user, kiosk, field_key, day) index caps spam regardless.
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

export interface RecordSignalResult {
  /** false iff the UNIQUE (user, kiosk, field, day) index already had a row. */
  inserted: boolean;
  signalId: string;
  /** True iff verifyPresence accepted the fix; persisted as the `verified` column. */
  verified: boolean;
  /** Set when not verified — the reason verifyPresence rejected. Not persisted. */
  reason?: VerifyReason;
}

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

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const assertedValue = input.action === "confirm" ? null : (input.assertedValue ?? null);

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO field_signals
       (id, kiosk_id, field_key, action, asserted_value, user_id, verified, region_slug, created_at, created_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.kioskId,
      input.fieldKey,
      input.action,
      assertedValue,
      input.userId,
      presence.verified ? 1 : 0,
      input.regionSlug,
      now,
      day,
    )
    .run();

  const inserted = (result.meta?.changes ?? 0) > 0;
  return presence.verified
    ? { inserted, signalId: id, verified: true }
    : { inserted, signalId: id, verified: false, reason: presence.reason };
}
