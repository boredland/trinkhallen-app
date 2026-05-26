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
 *   2. Play App Signing (Google's own key, after the first AAB upload):
 *        Play Console → Mit Google Play geschützt → Play app signing →
 *        "App signing key certificate" → SHA-256 fingerprint
 *
 * Both fingerprints MUST be listed simultaneously: the upload key covers
 * locally-built / sideloaded APKs, the Play App Signing key covers
 * everything installed from the Play Store (Google re-signs on their end).
 * Drop either and that install path launches in a Chrome Custom Tab with
 * a URL bar instead of fullscreen.
 *
 * `get_login_creds` is the second relation Play Console's generated
 * snippet includes — it lets the installed app and trinkhallen.app share
 * saved credentials via Google Password Manager. Harmless + useful given
 * we have Google / Apple / magic-link login.
 */
const ANDROID_PACKAGE_NAME = "app.trinkhallen.twa";

const SIGNING_CERT_SHA256: readonly string[] = [
  // Upload key (~/.android-keys/trinkhallen/upload.keystore, alias=upload).
  "2A:94:A8:C1:A7:2F:29:36:3A:A0:E2:45:DB:55:3C:00:96:53:7D:54:DC:E2:0C:1C:5E:AB:CD:5B:0B:06:26:DE",
  // Play App Signing key (Google-held, from the Play Console DAL snippet).
  "0B:77:55:F4:C0:7C:53:4A:CC:D5:00:C0:52:A5:8A:FE:A0:6B:02:4A:25:AE:8D:82:9C:B1:8B:0E:39:F4:58:A6",
];

export const wellKnown = new Hono<{ Bindings: Env }>();

wellKnown.get("/.well-known/assetlinks.json", (c) => {
  const body = [
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
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
