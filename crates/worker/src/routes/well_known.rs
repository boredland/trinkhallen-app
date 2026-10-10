//! `/.well-known/assetlinks.json` — Digital Asset Links, proving to Android
//! that we own this domain so the Trusted Web Activity (Play Store app
//! `app.trinkhallen.twa`) launches fullscreen instead of inside a Chrome
//! Custom Tab with a URL bar.
//!
//! Each fingerprint is the SHA-256 of a signing certificate, uppercase hex,
//! colon-separated. Both must be listed simultaneously: the upload key
//! covers locally-built / sideloaded APKs, the Play App Signing key covers
//! everything installed from the Play Store. `get_login_creds` is the second
//! relation Play Console's generated snippet includes.

use serde_json::json;
use worker::Result;

use crate::http;

const ANDROID_PACKAGE_NAME: &str = "app.trinkhallen.twa";

/// Upload key (`~/.android-keys/trinkhallen/upload.keystore`) and the Google
/// held Play App Signing key (Play Console → Play app signing).
const SIGNING_CERT_SHA256: [&str; 2] = [
    "2A:94:A8:C1:A7:2F:29:36:3A:A0:E2:45:DB:55:3C:00:96:53:7D:54:DC:E2:0C:1C:5E:AB:CD:5B:0B:06:26:DE",
    "0B:77:55:F4:C0:7C:53:4A:CC:D5:00:C0:52:A5:8A:FE:A0:6B:02:4A:25:AE:8D:82:9C:B1:8B:0E:39:F4:58:A6",
];

pub fn assetlinks() -> Result<worker::Response> {
    let body = json!([{
        "relation": [
            "delegate_permission/common.handle_all_urls",
            "delegate_permission/common.get_login_creds",
        ],
        "target": {
            "namespace": "android_app",
            "package_name": ANDROID_PACKAGE_NAME,
            "sha256_cert_fingerprints": SIGNING_CERT_SHA256,
        },
    }]);
    http::json(
        &body.to_string(),
        200,
        &[("cache-control", "public, max-age=3600")],
    )
}
