import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Digital Asset Links — proves to Android that we own this domain so the
 * Trusted Web Activity (Play Store app `app.trinkhallen.twa`) launches the
 * site fullscreen instead of inside a Chrome Custom Tab with a URL bar.
 *
 * Each fingerprint is the SHA-256 of a signing certificate, uppercase hex,
 * colon-separated. Order is irrelevant. Update via:
 *
 *   1. Generated locally:
 *        keytool -list -v -keystore ~/.android-keys/trinkhallen/upload.keystore \
 *          -alias upload | grep "SHA256:"
 *
 *   2. Play App Signing (only after the first AAB is accepted by Google):
 *        Play Console → App integrity → App signing → "App signing key
 *        certificate" → SHA-256 fingerprint
 *
 * Both fingerprints MUST be listed simultaneously, otherwise either internal
 * test builds OR production-from-Play installs will fail verification.
 */
const ANDROID_PACKAGE_NAME = "app.trinkhallen.twa";

const SIGNING_CERT_SHA256: readonly string[] = [
  // Upload key (~/.android-keys/trinkhallen/upload.keystore, alias=upload).
  "2A:94:A8:C1:A7:2F:29:36:3A:A0:E2:45:DB:55:3C:00:96:53:7D:54:DC:E2:0C:1C:5E:AB:CD:5B:0B:06:26:DE",
  // Play App Signing key — fill in after first AAB upload to Play Console:
  //   Play Console → App integrity → App signing → SHA-256 fingerprint
];

export const wellKnown = new Hono<{ Bindings: Env }>();

wellKnown.get("/.well-known/assetlinks.json", (c) => {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: SIGNING_CERT_SHA256,
      },
    },
  ];
  return c.json(body, 200, {
    "cache-control": "public, max-age=3600",
  });
});
