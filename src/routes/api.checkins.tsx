import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById } from "../lib/asset-kiosks";
import { recordCheckin, regionSlugFromPath } from "../lib/checkins";
import { resolveLang, t } from "../lib/messages";
import { hasPHToken, isPublicHolidayToday, kioskLocation } from "../lib/opening-hours";

export const apiCheckins = new Hono<{ Bindings: Env }>();

/**
 * Auto-files a `ph_open_observed` report so the moderator can confirm and
 * the existing approval flow appends `; PH open` to the data-repo hours.
 * Dedupes on (kiosk_id, observation_date): one report per Späti per PH,
 * regardless of how many users check in that day.
 */
async function fileObservationIfNew(
  env: Env,
  kioskId: string,
  userId: string,
  observationDate: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT 1 AS n FROM reports
       WHERE kiosk_id = ?
         AND kind = 'ph_open_observed'
         AND json_extract(payload, '$.observation_date') = ?
       LIMIT 1`,
  )
    .bind(kioskId, observationDate)
    .first<{ n: number }>();
  if (existing) return;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ observation_date: observationDate, verified: true });
  await env.DB.prepare(
    `INSERT INTO reports (id, kiosk_id, user_id, kind, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ph_open_observed', ?, 'open', ?, ?)`,
  )
    .bind(id, kioskId, userId, payload, now, now)
    .run();
}

/**
 * POST /api/checkins — silent "I was here" event log.
 *
 * Lat/lng are optional. When supplied and within 100m of the kiosk, the row
 * gets `verified=1`; otherwise `verified=0`. The form continues either way —
 * the verification is for future leaderboard scoring, not for gating writes.
 * Same-day re-taps are no-ops (UNIQUE index handles dedupe in lib/checkins).
 */
apiCheckins.post("/api/checkins", async (c) => {
  const lang = resolveLang(c.req.header("accept-language"));
  const user = c.get("user");
  if (!user) return c.text(t(lang, "error.loginRequired"), 401);

  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  if (!kioskId) return c.text(t(lang, "error.badRequest"), 400);

  const kiosk = await getKioskById(c.env, kioskId);
  if (!kiosk) return c.text(t(lang, "error.kioskNotFound"), 404);

  const userLatRaw = (form.get("lat") ?? "").toString();
  const userLngRaw = (form.get("lng") ?? "").toString();
  const accuracyRaw = (form.get("accuracy") ?? "").toString();
  const userLat = userLatRaw ? parseFloat(userLatRaw) : NaN;
  const userLng = userLngRaw ? parseFloat(userLngRaw) : NaN;
  const accuracy = accuracyRaw ? parseFloat(accuracyRaw) : NaN;

  const outcome = await recordCheckin(c.env, {
    kioskId: kiosk.id,
    kioskLat: kiosk.lat,
    kioskLng: kiosk.lng,
    regionSlug: regionSlugFromPath(kiosk.region),
    userId: user.id,
    ...(Number.isFinite(userLat) && Number.isFinite(userLng) ? { userLat, userLng } : {}),
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
  });

  // PH-data-gap capture: when a verified check-in lands on a public holiday
  // at a kiosk whose hours carry no PH rule, file a (deduped) report. The
  // physical presence is strong evidence the kiosk is open today; the
  // moderator confirms before the data repo gets touched.
  if (outcome.inserted && outcome.verified && kiosk.hours?.raw && !hasPHToken(kiosk.hours.raw)) {
    const today = new Date();
    if (isPublicHolidayToday(kioskLocation(kiosk), today)) {
      const observationDate = today.toISOString().slice(0, 10);
      await fileObservationIfNew(c.env, kiosk.id, user.id, observationDate);
    }
  }

  // The check-in is silent in V1 — no UI consumes the response. The form on
  // the page reveals the gap questions client-side regardless of outcome.
  return c.body(null, 204);
});
