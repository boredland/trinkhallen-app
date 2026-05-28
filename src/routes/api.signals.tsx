import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById } from "../lib/asset-kiosks";
import { regionSlugFromPath } from "../lib/checkins";
import { recordSignal, type SignalAction } from "../lib/signals";

export const apiSignals = new Hono<{ Bindings: Env }>();

const ALLOWED_ACTIONS: ReadonlySet<SignalAction> = new Set(["confirm", "dispute", "fill"]);

/**
 * POST /api/signals — always-record write-path for per-field signals.
 *
 * Auth required. The row always lands in `field_signals`; the `verified` column
 * captures whether the user had a fresh in-range fix (verifyPresence). Same-day
 * re-confirms silently dedup via the UNIQUE index. Response is a small JSON
 * `{ verified, reason }` so the client can show high- vs low-confidence
 * feedback ("✓ Bestätigt — danke!" vs "Bestätigt, ohne Vor-Ort-Prüfung — zählt
 * nur leise.").
 */
apiSignals.post("/api/signals", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Bitte anmelden.", 401);

  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  const fieldKey = (form.get("field_key") ?? "").toString();
  const action = (form.get("action") ?? "").toString();
  if (!kioskId || !fieldKey || !action) return c.text("Bad request", 400);
  if (!ALLOWED_ACTIONS.has(action as SignalAction)) return c.text("Bad action", 400);

  const kiosk = await getKioskById(c.env, kioskId);
  if (!kiosk) return c.text("Kiosk nicht gefunden", 404);

  const userLatRaw = (form.get("lat") ?? "").toString();
  const userLngRaw = (form.get("lng") ?? "").toString();
  const accuracyRaw = (form.get("accuracy") ?? "").toString();
  const userLat = userLatRaw ? parseFloat(userLatRaw) : NaN;
  const userLng = userLngRaw ? parseFloat(userLngRaw) : NaN;
  const accuracy = accuracyRaw ? parseFloat(accuracyRaw) : NaN;

  const assertedRaw = form.get("asserted_value");
  const assertedValue = assertedRaw ? assertedRaw.toString() : null;

  const result = await recordSignal(c.env, {
    kioskId: kiosk.id,
    kioskLat: kiosk.lat,
    kioskLng: kiosk.lng,
    regionSlug: regionSlugFromPath(kiosk.region),
    userId: user.id,
    fieldKey,
    action: action as SignalAction,
    assertedValue,
    ...(Number.isFinite(userLat) && Number.isFinite(userLng) ? { userLat, userLng } : {}),
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
  });

  return c.json({ verified: result.verified, reason: result.reason ?? null });
});
