/**
 * Check-in event log + strict verified-presence primitive.
 *
 * `recordCheckin` is the soft path used by the "Ich war hier" tap — a fix is
 * never required, same-day re-taps are deduped via the UNIQUE index in
 * migration 0006. `verifyPresence` is the strict primitive that downstream
 * features (the Frische gamification, #5) call to hard-block scored actions
 * without a fresh in-range fix; it returns verified-or-not with a precise
 * reason so callers can show clear UX.
 *
 * Both share the same accuracy-aware fence: the GPS fix's reported accuracy
 * pads VERIFY_RADIUS_M up to ACCURACY_CAP_M so a noisy urban fix at the kiosk
 * still counts, while a 5000m "accuracy" can't pretend you're anywhere. The
 * cap is what makes the fence honest — without it the radius would expand
 * with the lie.
 *
 * Each verified check-in also runs impossible-travel detection: same user,
 * verified at a distant kiosk implausibly recently ⇒ an anomaly lands on
 * user_anomalies for moderator review. It's a backstop (client coords are
 * spoofable anyway), so it doesn't block the check-in itself.
 */

import type { Env } from "../env";
import { getKioskById } from "./asset-kiosks";
import { haversineMeters } from "./geo";

const VERIFY_RADIUS_M = 100;
const ACCURACY_CAP_M = 250;
const MAX_TRAVEL_MPS = 139; // ~500 km/h; tune on recorded data later

export type VerifyReason = "no_fix" | "out_of_range" | "low_accuracy";

export type VerifyPresenceResult =
  | { verified: true; distance: number }
  | { verified: false; reason: VerifyReason; distance: number | null };

interface VerifyArgs {
  kioskLat: number;
  kioskLng: number;
  userLat?: number;
  userLng?: number;
  /** GPS-reported accuracy radius in meters; missing ⇒ treat as no padding. */
  accuracy?: number;
}

/**
 * Decide whether the user is verifiably at the kiosk. The soft "Ich war hier"
 * tap just records `verified`; the strict (rewarded) path hard-blocks on
 * anything but `verified: true` and surfaces `reason` to the user.
 */
export function verifyPresence(args: VerifyArgs): VerifyPresenceResult {
  if (typeof args.userLat !== "number" || typeof args.userLng !== "number") {
    return { verified: false, reason: "no_fix", distance: null };
  }
  const distance = haversineMeters(
    { lat: args.userLat, lng: args.userLng },
    { lat: args.kioskLat, lng: args.kioskLng },
  );
  const acc = typeof args.accuracy === "number" && args.accuracy >= 0 ? args.accuracy : 0;
  const allowance = VERIFY_RADIUS_M + Math.min(acc, ACCURACY_CAP_M);
  if (distance <= allowance) return { verified: true, distance };
  // Out of range with a wildly-large accuracy ⇒ the fix itself is the problem;
  // surface that so the strict-path UX can say "couldn't confirm you're here"
  // rather than "you're not here".
  if (acc > ACCURACY_CAP_M) return { verified: false, reason: "low_accuracy", distance };
  return { verified: false, reason: "out_of_range", distance };
}

export interface CheckinInput {
  kioskId: string;
  kioskLat: number;
  kioskLng: number;
  /** Region slug derived from kiosk.region path (e.g. "frankfurt"). */
  regionSlug: string;
  userId: string;
  /** Browser geolocation, if the user granted it. */
  userLat?: number;
  userLng?: number;
  /** GPS accuracy radius (meters) — pads the verify radius up to ACCURACY_CAP_M. */
  accuracy?: number;
}

export interface CheckinOutcome {
  /** false if the UNIQUE index already had a row for (kiosk, user, day). */
  inserted: boolean;
  verified: boolean;
  /** Set when not verified — useful for callers that need to explain why. */
  reason?: VerifyReason;
}

export async function recordCheckin(env: Env, input: CheckinInput): Promise<CheckinOutcome> {
  const result = verifyPresence({
    kioskLat: input.kioskLat,
    kioskLng: input.kioskLng,
    userLat: input.userLat,
    userLng: input.userLng,
    accuracy: input.accuracy,
  });
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);

  // INSERT OR IGNORE: the UNIQUE (kiosk_id, user_id, created_day) index makes
  // a same-day re-tap a no-op without throwing.
  const dbResult = await env.DB.prepare(
    `INSERT OR IGNORE INTO checkins
       (id, kiosk_id, user_id, region_slug, verified, created_at, created_day, accuracy, distance_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.kioskId,
      input.userId,
      input.regionSlug,
      result.verified ? 1 : 0,
      now,
      day,
      input.accuracy ?? null,
      result.distance,
    )
    .run();

  const inserted = (dbResult.meta?.changes ?? 0) > 0;

  if (inserted && result.verified) {
    try {
      await detectImpossibleTravel(
        env,
        input.userId,
        id,
        input.kioskId,
        input.kioskLat,
        input.kioskLng,
        now,
      );
    } catch (err) {
      // Detection is a backstop, not a blocker — failure must not fail the tap.
      console.error("impossible-travel check failed", err);
    }
  }

  if (result.verified) return { inserted, verified: true };
  return { inserted, verified: false, reason: result.reason };
}

async function detectImpossibleTravel(
  env: Env,
  userId: string,
  currentCheckinId: string,
  kioskId: string,
  kioskLat: number,
  kioskLng: number,
  nowSec: number,
): Promise<void> {
  const prev = await env.DB.prepare(
    `SELECT kiosk_id AS prevKioskId, created_at AS prevAt
       FROM checkins
       WHERE user_id = ? AND verified = 1 AND id != ?
       ORDER BY created_at DESC
       LIMIT 1`,
  )
    .bind(userId, currentCheckinId)
    .first<{ prevKioskId: string; prevAt: number }>();
  if (!prev || prev.prevKioskId === kioskId) return;

  const prevKiosk = await getKioskById(env, prev.prevKioskId);
  if (!prevKiosk) return;

  const distance = haversineMeters(
    { lat: prevKiosk.lat, lng: prevKiosk.lng },
    { lat: kioskLat, lng: kioskLng },
  );
  const seconds = Math.max(nowSec - prev.prevAt, 1);
  if (distance / seconds <= MAX_TRAVEL_MPS) return;

  const payload = JSON.stringify({
    from_kiosk_id: prev.prevKioskId,
    to_kiosk_id: kioskId,
    distance_m: Math.round(distance),
    seconds,
    kmh: Math.round((distance / seconds) * 3.6),
  });
  await env.DB.prepare(
    `INSERT INTO user_anomalies (id, user_id, kind, payload, created_at)
       VALUES (?, ?, 'impossible_travel', ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, payload, nowSec)
    .run();
}

/**
 * Pull a region slug out of `kiosk.region`, which is a repo-style path like
 * `de/hessen/frankfurt`. Used by /api/checkins to scope the row. Lives here
 * (next to `recordCheckin`) so the slug derivation has one home.
 */
export function regionSlugFromPath(region: string): string {
  const trimmed = region.replace(/\.geojson$/, "");
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? trimmed;
}
