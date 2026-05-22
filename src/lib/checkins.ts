/**
 * Check-in event log. Silent — V1 has no UI that reads from the table; the
 * write path exists so a future leaderboard layer starts with real history
 * instead of an empty table. See plan i-am-thinking-about-synchronous-lerdorf.
 *
 * `recordCheckin` deduplicates per (kiosk, user, day) via the UNIQUE index in
 * migration 0006; same-day re-taps are a no-op. The `verified` flag is set
 * iff the caller supplies coordinates within VERIFY_RADIUS_M of the kiosk.
 */

import type { Env } from "../env";
import { haversineMeters } from "./geo";

const VERIFY_RADIUS_M = 100;

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
}

export interface CheckinOutcome {
  /** false if the UNIQUE index already had a row for (kiosk, user, day). */
  inserted: boolean;
  verified: boolean;
}

export async function recordCheckin(env: Env, input: CheckinInput): Promise<CheckinOutcome> {
  const verified = (() => {
    if (typeof input.userLat !== "number" || typeof input.userLng !== "number") return false;
    const meters = haversineMeters(
      { lat: input.userLat, lng: input.userLng },
      { lat: input.kioskLat, lng: input.kioskLng },
    );
    return meters <= VERIFY_RADIUS_M;
  })();

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);

  // INSERT OR IGNORE: the UNIQUE (kiosk_id, user_id, created_day) index makes
  // a same-day re-tap a no-op without throwing.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO checkins
       (id, kiosk_id, user_id, region_slug, verified, created_at, created_day)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.kioskId, input.userId, input.regionSlug, verified ? 1 : 0, now, day)
    .run();

  return { inserted: (result.meta?.changes ?? 0) > 0, verified };
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
