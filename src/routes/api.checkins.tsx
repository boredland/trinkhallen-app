import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById } from "../lib/asset-kiosks";
import { recordCheckin, regionSlugFromPath } from "../lib/checkins";

export const apiCheckins = new Hono<{ Bindings: Env }>();

/**
 * POST /api/checkins — silent "I was here" event log.
 *
 * Lat/lng are optional. When supplied and within 100m of the kiosk, the row
 * gets `verified=1`; otherwise `verified=0`. The form continues either way —
 * the verification is for future leaderboard scoring, not for gating writes.
 * Same-day re-taps are no-ops (UNIQUE index handles dedupe in lib/checkins).
 */
apiCheckins.post("/api/checkins", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Bitte anmelden.", 401);

  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  if (!kioskId) return c.text("Bad request", 400);

  const kiosk = await getKioskById(c.env, kioskId);
  if (!kiosk) return c.text("Kiosk nicht gefunden", 404);

  const userLatRaw = (form.get("lat") ?? "").toString();
  const userLngRaw = (form.get("lng") ?? "").toString();
  const userLat = userLatRaw ? parseFloat(userLatRaw) : NaN;
  const userLng = userLngRaw ? parseFloat(userLngRaw) : NaN;

  await recordCheckin(c.env, {
    kioskId: kiosk.id,
    kioskLat: kiosk.lat,
    kioskLng: kiosk.lng,
    regionSlug: regionSlugFromPath(kiosk.region),
    userId: user.id,
    ...(Number.isFinite(userLat) && Number.isFinite(userLng) ? { userLat, userLng } : {}),
  });

  // The check-in is silent in V1 — no UI consumes the response. The form on
  // the page reveals the gap questions client-side regardless of outcome.
  return c.body(null, 204);
});
