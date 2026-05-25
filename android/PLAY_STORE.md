# Play Store submission — trinkhallen.app TWA

This is the operator's playbook for getting `app.trinkhallen.twa` listed on Google Play. The local build artifacts are already produced; the remaining work is account setup, store assets, and Play Console flow.

## 0. Local artifacts (already produced)

| Path | What it is |
|------|------------|
| `android/app-release-bundle.aab` | Signed Android App Bundle to upload to Play. |
| `android/app-release-signed.apk` | Same code as an APK, for sideload-testing on a real device via `adb install`. |
| `android/twa-manifest.json` | Source of truth for the wrapper. Bump `appVersionCode` (integer, +1 each release) and `appVersionName` here, then rebuild. |
| `~/.android-keys/trinkhallen/upload.keystore` | The upload key. Never commit. Back this up alongside `passwords.txt`. |
| `~/.android-keys/trinkhallen/passwords.txt` | Keystore password. PKCS12 → store password == key password. Treat like a root credential. |
| `src/routes/well-known.tsx` | Serves `/.well-known/assetlinks.json`. The upload-key SHA-256 is already filled in. Play App Signing key SHA-256 needs to be appended after first upload (see step 4). |

Rebuild flow (when you change manifest or code):

```bash
cd android
export JAVA_HOME=/home/jonass/.local/share/mise/installs/java/temurin-17.0.19+10
export ANDROID_HOME=/home/jonass/.android-sdk
export PATH=$JAVA_HOME/bin:$PATH
export BUBBLEWRAP_KEYSTORE_PASSWORD=$(grep '^KEYSTORE_PASSWORD=' ~/.android-keys/trinkhallen/passwords.txt | cut -d= -f2-)
export BUBBLEWRAP_KEY_PASSWORD="$BUBBLEWRAP_KEYSTORE_PASSWORD"
bubblewrap build      # answer "Yes" if it asks to update from twa-manifest.json
```

## 1. Play Developer account (one-time, ~1-3 days)

1. Go to <https://play.google.com/console/u/0/signup>.
2. Pick **Personal** (faster ID verification) or **Organization** (needs D-U-N-S number).
3. Pay the **$25 one-time** registration fee.
4. Complete identity verification (passport / ID upload; Google may take 1-3 days).
5. Once approved, accept the Developer Distribution Agreement.

While you wait, you can finish the asset checklist (step 2).

## 2. Store assets checklist

Required by Play (exact pixel sizes; PNG, no transparency unless noted):

| Asset | Status | Source / Action |
|-------|--------|-----------------|
| App icon, 512×512 | ✅ have it | `public/icon-512.png` (also `logo-512.png`). |
| Feature graphic, 1024×500 | ⚠️ **MISSING** | Need a banner that crops the wordmark + a Trinkhalle photo or map. No text edge-cropping (Play overlays the title). |
| Phone screenshots (≥2) | ⚠️ only 1 (`screenshot-narrow.png`) | Min 320 px, max 3840 px on each side, 9:16 or 16:9 ratio. Already have `824×1830`. Generate a second one: detail page, or filter chips visible. |
| 7" tablet screenshots (optional but boosts the listing) | ❌ | Optional; skip for v1. |
| 10" tablet screenshots (optional) | ❌ | Optional; skip for v1. |
| Short description, ≤80 chars (DE + EN) | TODO | See suggested copy below. |
| Full description, ≤4000 chars (DE + EN) | TODO | See suggested copy below. |
| Privacy policy URL | ✅ | `https://trinkhallen.app/datenschutz` (already extended for the Android section). |
| App category | choose | "Maps & Navigation" (primary), or "Lifestyle". |
| Content rating | answered in console | All "No" — no UGC moderation concerns for Play purposes; the app is informational mapping. *But*: ratings/reports/check-ins are user-generated, so on the questionnaire mark "Users can interact" and link the moderation flow (`/moderate`). |
| Target audience | 13+ | TWAs are forbidden from targeting <13 (Play Families policy). |

### Suggested store copy

**App title** (max 30 chars): `trinkhallen.app`

**Short description (DE)** (max 80):
> Trinkhallen, Spätis, Wasserhäuschen — offen, durchsuchbar, nicht-kommerziell.

**Short description (EN)** (max 80):
> Germany's Trinkhallen, Spätis & Wasserhäuschen — open, searchable, non-profit.

**Full description (DE)** — adapt freely:
> Finde Trinkhallen, Spätis und Wasserhäuschen in ganz Deutschland — auf einer interaktiven Karte oder als sortierte Liste pro Stadt. Öffnungszeiten, Adresse, Navigation per Tap.
>
> trinkhallen.app ist ein offenes, nicht-kommerzielles Projekt. Die Daten leben in einem öffentlichen GitHub-Repository und werden mit OpenStreetMap synchronisiert. Korrekturen, Vorschläge und Bewertungen kannst du direkt aus der App heraus beitragen.
>
> Funktionen
> • Karten- und Listenansicht mit Filtern (offen jetzt, 24/7, mit Sitzgelegenheit, …)
> • Per-Stadt-Übersichten für Frankfurt, Köln, Berlin, Düsseldorf, München und mehr
> • Detailseiten mit Öffnungszeiten, Navigations-Link und Bewertungen
> • Optionaler Login (E-Mail oder Google), um eigene Bewertungen, Check-ins und Daten-Korrekturen zu teilen
> • Keine Tracker, keine Werbung, kein Analytics
>
> Die App ist ein Wrapper um die Website trinkhallen.app. Den Datenschutz findest du unter trinkhallen.app/datenschutz.

**Full description (EN)** — minimal port; or skip if you list as DE-only.

## 3. Play Console: create app & upload AAB

1. **All apps → Create app**
   - App name: `trinkhallen.app`
   - Default language: German (Germany) — `de-DE`
   - Type: App
   - Free or paid: **Free**
   - Declarations: tick both (developer policies + US export laws).
2. Skip the dashboard wizard for now; head straight to **Release → Testing → Internal testing**.
3. **Create new release**:
   - **App bundles**: upload `android/app-release-bundle.aab`.
   - Release name: auto-fills from `versionName` (`1`).
   - Release notes: `Erstveröffentlichung.`
4. Save (do NOT roll out yet — wait until step 4 below).
5. Add yourself as an internal tester: **Testers** tab → create a list with your Gmail.

## 4. Wire up Play App Signing → finish assetlinks (critical)

Once the AAB is saved to a release (no rollout needed):

1. **App integrity → App signing** in the left nav.
2. Copy the **SHA-256 certificate fingerprint** listed under "App signing key certificate" (this is Google's key, *not* your upload key).
3. Edit `src/routes/well-known.tsx`:
   ```ts
   const SIGNING_CERT_SHA256: readonly string[] = [
     "2A:94:A8:C1:A7:2F:29:36:3A:A0:E2:45:DB:55:3C:00:96:53:7D:54:DC:E2:0C:1C:5E:AB:CD:5B:0B:06:26:DE", // upload
     "XX:XX:...", // Play App Signing — paste the value from Play Console
   ];
   ```
4. Commit + push. The auto-deploy will publish the updated `https://trinkhallen.app/.well-known/assetlinks.json`.
5. Verify with: `curl https://trinkhallen.app/.well-known/assetlinks.json | jq` — both fingerprints should appear.
6. Verify Google can fetch + parse it: <https://developers.google.com/digital-asset-links/tools/generator>. Plug in `app.trinkhallen.twa` and both fingerprints; the tool will probe `/.well-known/assetlinks.json` and report OK/FAIL.

**Why this matters**: Without both fingerprints, the TWA opens but Android shows a browser URL bar at the top ("about://" Custom Tab fallback). With both, it's fullscreen, indistinguishable from a native app.

## 5. Fill remaining Play Console sections

Sections that block production rollout (look for red dots in the left nav):

- **App content → Privacy policy**: `https://trinkhallen.app/datenschutz`.
- **App content → App access**: select "All functionality available without restrictions" (no login is required to use the map).
- **App content → Ads**: "No, my app does not contain ads".
- **App content → Content rating**: complete the IARC questionnaire. Likely **Everyone / PEGI 3**.
- **App content → Target audience**: ages **13+**. Confirm app is not designed for children.
- **App content → News app**: No.
- **App content → COVID-19 contact tracing**: No.
- **App content → Data safety**: see next section.
- **App content → Government app**: No.
- **App content → Financial features**: None.
- **App content → Health**: None.
- **Store presence → Main store listing**: title, short/full descriptions, all the assets from step 2.
- **Store presence → Store settings**: category "Maps & Navigation", tags optional.
- **Store presence → Store listing experiments**: skip.

### Data safety form (this is the one people get wrong)

Trinkhallen-specific answers:

| Question | Answer |
|----------|--------|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all the user data collected by your app encrypted in transit? | **Yes** (HTTPS-only via Cloudflare) |
| Do you provide a way for users to request that their data be deleted? | **Yes** — link to `https://trinkhallen.app/datenschutz#deine-rechte` (or just `/datenschutz`) |

Data types to disclose (only these — the rest are "No"):

- **Personal info → Email address** — Collected, Optional, Purpose: account management; Shared: No.
- **Personal info → Name** — Collected (via Google OAuth profile), Optional, Purpose: account management; Shared: No.
- **Personal info → User IDs** — Collected, Required (if logged in), Purpose: account management; Shared: **Yes** with GitHub (the user UUID is published in the trinkhallen-data repo's PR metadata) — describe as "user-generated content metadata in public open-data repository, no personal info attached to the UUID".
- **Photos and videos → Photos** — Collected (via Google OAuth avatar URL), Optional; Shared: No.
- **App activity → App interactions** — Collected (ratings, check-ins, submissions), Required for logged-in users, Purpose: app functionality; Shared: **Yes** with GitHub (the contribution PR contains the change).
- **App activity → In-app search history** — No.
- **App info and performance → Crash logs** — No (we don't ship Firebase Crashlytics; the TWA forwards crashes to Google Play but those go to Play, not us).
- **Device or other IDs** — No.

When Play asks about **why** data is collected, pick "Account management" and "App functionality" — never "Analytics" or "Advertising or marketing".

## 6. Internal testing → production rollout

1. Once Play approves your account + the listing passes review (~24-48h), promote the internal release to **closed testing** (add 5-10 testers) for a week if you want a soft launch — otherwise skip to step 2.
2. **Release → Production → Create new release**. Promote the same AAB from internal testing (no rebuild needed).
3. Submit for review. First review can take 3-7 days. Subsequent updates are usually <24h.
4. After approval, the app appears at `https://play.google.com/store/apps/details?id=app.trinkhallen.twa`.

## 7. Future releases — checklist

Every time you ship an update:

1. Bump `appVersionCode` (integer +1) in `android/twa-manifest.json`. Also bump `appVersionName` to a human string (e.g., `1.1`).
2. `cd android && bubblewrap build` (with env vars from step 0).
3. Play Console → **Production → Create new release** → upload the new `app-release-bundle.aab`.
4. Add release notes (≤500 chars per locale).
5. Roll out (you can stage 1% → 10% → 100% if you want canary safety).

The web app and TWA share the same code — most changes are *just* web deploys, no Play update needed. You only need a new Play release when:
- The PWA manifest URL changes
- The package ID changes (it shouldn't, ever)
- You add native Android features (Play Billing, etc.)
- Play security/policy mandates a rebuild against a newer target SDK

## 8. Troubleshooting

**App shows URL bar at top after install** → assetlinks.json doesn't include the Play App Signing fingerprint. Re-check step 4. Test fetch from a clean network: `curl -sI https://trinkhallen.app/.well-known/assetlinks.json` should show `content-type: application/json` and 200.

**`bubblewrap build` fails with "Could not find tools.jar"** → JAVA_HOME points at JDK 9+ headless image without `tools.jar`. Use the Temurin 17 path: `/home/jonass/.local/share/mise/installs/java/temurin-17.0.19+10`.

**Play upload rejects with "Signature does not match"** → you rebuilt with a different keystore. Restore from backup; the upload key is irreplaceable for this package ID. (Play App Signing has a reset-upload-key flow if it's truly lost; the actual signing key in Play's vault is not affected.)

**Gradle "deprecated features" warnings** → harmless, ignore.
