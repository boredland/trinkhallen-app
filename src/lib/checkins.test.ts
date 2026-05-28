import { describe, expect, it } from "bun:test";
import { verifyPresence } from "./checkins";

// Reference point in Frankfurt; the math doesn't care which kiosk, only that
// reasoning is consistent across cases.
const KIOSK = { lat: 50.1109, lng: 8.6821 };
// At lat ≈ 50.1°, 1° longitude ≈ 71_500 m. These offsets land roughly at the
// indicated metre distances east of the kiosk; tests assert reasons/booleans,
// not exact metres, so the approximation is fine.
const OFFSET_215M = 0.003;
const OFFSET_430M = 0.006;

describe("verifyPresence", () => {
  it("verifies a fix at the kiosk", () => {
    const r = verifyPresence({
      kioskLat: KIOSK.lat,
      kioskLng: KIOSK.lng,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng,
    });
    expect(r.verified).toBe(true);
  });

  it("returns no_fix when coordinates are missing", () => {
    expect(verifyPresence({ kioskLat: KIOSK.lat, kioskLng: KIOSK.lng })).toEqual({
      verified: false,
      reason: "no_fix",
      distance: null,
    });
  });

  it("rejects a fix far from the kiosk as out_of_range", () => {
    // Berlin — well over a hundred kilometres, far outside any accuracy padding.
    const r = verifyPresence({
      kioskLat: KIOSK.lat,
      kioskLng: KIOSK.lng,
      userLat: 52.52,
      userLng: 13.405,
    });
    expect(r).toMatchObject({ verified: false, reason: "out_of_range" });
  });

  it("absorbs accuracy noise up to the cap", () => {
    // ~215 m away. Without accuracy that's out (>100 m); with accuracy=150 the
    // allowance becomes 100 + 150 = 250, so the fix passes.
    const r = verifyPresence({
      kioskLat: KIOSK.lat,
      kioskLng: KIOSK.lng,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng + OFFSET_215M,
      accuracy: 150,
    });
    expect(r.verified).toBe(true);
  });

  it("caps accuracy padding so a huge accuracy can't wave anything through", () => {
    // ~430 m away with accuracy=5000. Allowance caps at 100 + 250 = 350 m, so
    // the fix is out, and the reason surfaces as low_accuracy (not out_of_range)
    // because the accuracy itself exceeded the cap.
    const r = verifyPresence({
      kioskLat: KIOSK.lat,
      kioskLng: KIOSK.lng,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng + OFFSET_430M,
      accuracy: 5000,
    });
    expect(r).toMatchObject({ verified: false, reason: "low_accuracy" });
  });

  it("does not let a tight-but-noisy fix help — small accuracy, distance still too far", () => {
    // ~430 m away with accuracy=50: allowance = 150 m, out_of_range (acc within cap).
    const r = verifyPresence({
      kioskLat: KIOSK.lat,
      kioskLng: KIOSK.lng,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng + OFFSET_430M,
      accuracy: 50,
    });
    expect(r).toMatchObject({ verified: false, reason: "out_of_range" });
  });
});
