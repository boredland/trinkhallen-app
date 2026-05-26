# trinkhallen.app

A finder for German **Trinkhallen**, **Wasserhäuschen** and **Spätis** — built on Cloudflare Workers + Hono.
The data lives openly at [`boredland/trinkhallen-data`](https://github.com/boredland/trinkhallen-data).

> Inspired by [HopfenStop](https://app.hopfenstop.de/) (CC BY-NC 4.0). Data extended via OpenStreetMap (ODbL).
> trinkhallen.app is **non-commercial**.

## Architecture

Cloudflare Worker (Hono SSR + JSX) on the edge, MapLibre GL JS island on the
client. Kiosk data is **static**: the trinkhallen-data repo is shallow-cloned
at build time and its per-region `data/<state>/<city>.geojson` files are
copied into `dist/static/data/`, served via the Workers Assets binding. The
client picks the files intersecting the viewport from a manifest and unions
them; below zoom 9 four pre-baked supercluster snapshots
(`_summary_z5..z8.geojson`) drive a refined per-zoom overview without
loading any region files.

D1 stays small and holds only **user-generated content**:

| Table | What |
|---|---|
| `users`, `sessions`, `magic_links` | Auth — Google SSO + magic-link, set-once `username`, transparent linking. `users.banned_at` non-NULL shadow-bans ratings. A sentinel row `00000000-0000-0000-0000-000000000000` ("Gelöschtes Konto") inherits already-merged contributions when a real account is deleted. |
| `ratings` | 1–5 stars + optional comment, one per user per kiosk. `kiosk_id` is a plain TEXT (no FK target — the `kiosks` table was dropped in 0004; 0009 rebuilt `ratings` to match). |
| `reports` | Edit requests (`wrong_hours`, `wrong_address`, `wrong_name`, `closed`, `update_payment`, `update_tags`, `ph_open_observed`, `duplicate`, `other`). `ph_open_observed` is auto-filed by the check-in handler when a verified check-in lands on a Bundesland public holiday at a kiosk whose hours carry no PH rule. |
| `submissions` | Proposed new kiosks (form → moderator approval → PR) |
| `checkins` | "Ich war hier" event log — per (kiosk, user, day) UNIQUE, `verified` if geolocation matched within 100 m. No UI reads it yet; captured for a future leaderboard. |

There is **no** `kiosks` table any more — the map, side panel, `/k/:id`, and
the `nearest`/bbox APIs all read from the static assets via
`src/lib/asset-kiosks.ts` (module-scope cache for the isolate lifetime).
Pushing to `boredland/trinkhallen-data` no longer touches D1; instead it
pokes a Cloudflare Deploy Hook so the next deploy rebuilds with fresh data.

## Local development

```sh
mise install                                # toolchains
bun install                                # also runs `lefthook install`
bun run db:migrate:local                       # D1 schema for the user-gen tables
cp .env.example .dev.vars                   # any secrets you have
TRINKHALLEN_DATA_PATH=../trinkhallen-data bun run build   # one-time, refreshes static data
bun run preview                                # wrangler dev
```

`bun run dev` (Vite + Miniflare) is also available if you need HMR; it expects
`dist/static/data/` to exist from a prior `bun run build:data`.

Pre-commit runs **biome check --write** (auto-fix + restage) and
**tsc --noEmit** (full project) in parallel via lefthook. To bypass in an
emergency: `git commit --no-verify`.

## Deploy

Cloudflare Workers Builds watches `main` and deploys on every push. Do **not**
run `wrangler deploy` from the CLI — the Builds run pulls trinkhallen-data
fresh; an out-of-band CLI deploy uses whatever stale snapshot is on your
disk.

D1 migrations are **not** automatic. After a push that adds a migration:

```sh
bun run db:migrate:remote
```

One-time operator setup:

```sh
# Cloudflare resources
wrangler d1 create trinkhallen-prod          # copy database_id into wrangler.toml

# Secrets (interactive prompts)
wrangler secret put SESSION_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_INSTALLATION_ID

# Apple Sign-In — required by App Store Guideline 4.8 for the iOS wrapper.
# Setup at developer.apple.com:
#   1. Identifiers → "+" → Services IDs → e.g. "app.trinkhallen.signin"
#      → enable Sign In with Apple → Configure: primary App ID =
#      app.trinkhallen.ios, return URL = https://trinkhallen.app/auth/apple/callback
#   2. Keys → "+" → name "trinkhallen-signin" → enable Sign In with Apple
#      → Configure: primary App ID = app.trinkhallen.ios → download the .p8
#      (one-shot download; back it up like the App Store Connect key)
wrangler secret put APPLE_SIGN_IN_SERVICES_ID   # e.g. app.trinkhallen.signin
wrangler secret put APPLE_SIGN_IN_TEAM_ID       # 10-char Developer Team ID
wrangler secret put APPLE_SIGN_IN_KEY_ID        # 10-char key ID from step 2
wrangler secret put APPLE_SIGN_IN_PRIVATE_KEY   # paste full .p8 contents

# Promote yourself to moderator (after first login created your user row).
wrangler d1 execute trinkhallen-prod --remote --command \
  "UPDATE users SET role='moderator' WHERE email='you@example.com'"

# Cloudflare Deploy Hook for data-repo-driven deploys:
#   Workers & Pages → trinkhallen-app → Settings → Builds → Deploy Hooks → Create.
#   Copy the URL, stash it as the CF_DEPLOY_HOOK_URL Actions secret on
#   boredland/trinkhallen-data (used by .github/workflows/deploy-app.yml there).
```

## Repository layout

```
src/
  index.ts                  Hono entry, middleware, route registration
  env.d.ts                  Cloudflare bindings + Hono context types
  routes/
    pages.tsx               SSR pages (/, /about, /stadt/:slug, /k/:id, /add,
                            /me, /me/username, /moderate, /impressum, /datenschutz)
    api.kiosks.tsx          Legacy fallback API — map reads /data/* directly
    api.ratings.tsx         Stars + comment writeback
    api.reports.tsx         Gap-fill + "Daten falsch?" submissions (eight kinds)
    api.submissions.tsx     "Späti vorschlagen" submission
    api.checkins.tsx        Silent "Ich war hier" event log
    auth.tsx                Google SSO + magic-link, transparent merge by email
    moderate.tsx            /moderate UI + approve/reject endpoints
    well-known.tsx          /.well-known/assetlinks.json (Android TWA verification)
  components/
    Layout.tsx, KioskList.tsx, KioskDetail.tsx, FilterChips.tsx,
    CheckinForm.tsx, ReportForm.tsx, RatingBlock.tsx
  lib/
    asset-kiosks.ts         Reads /data/*.geojson via env.ASSETS.fetch, caches per isolate
    assets.ts               Asset-manifest helper used by SSR script/link tags
    db.ts                   KioskRecord shape (no D1 queries any more)
    filters.ts              Query-string ⇄ KioskFilter, applies on the server side
    regions.ts, geo.ts      Region slug ↔ bbox, point-in-bbox helpers
    opening-hours.ts        Wrapper around the `opening_hours` library
    kind.ts, tags.ts        Kiosk kind/payment classification
    checkins.ts             recordCheckin + region-slug derivation
    ratings.ts              Aggregate + per-user rating queries
    reports.ts              Insert + status transitions for the eight report kinds
    users.ts                User row helpers + ban / delete handling
    usernames.ts            Validation + reserved-slug list + set-once UPDATE
    magic.ts, session.ts    Magic-link tokens + signed session cookie
    moderation.ts           Approve/reject → auto-PR / Issue via GitHub App
    github.ts, github-app.ts, github-pr.ts   GitHub App auth + Git Data API
    email.ts                Magic-link mailer via Cloudflare Email Routing
    navigate.ts             "Open in Google Maps / Apple Maps" URL builders
    manifest.generated.ts   (generated by scripts/write-asset-manifest.ts)
    *.test.ts               bun-test units (moderation, regions, reports)
  client/
    app.entry.ts            Theme + filter form + sidebar + island installers
    map.entry.ts            MapLibre island (per-zoom summary layers + clusters)
    pick.entry.ts           /add flow's pickable map
    build-style.ts          Picks the OpenFreeMap style URL by theme
    region-store.ts         Fetches manifest + per-region geojsons + summaries, caches
    client-filters.ts       Client-side mirror of lib/filters.ts (fuse + opening_hours bundled)
    checkin.ts              "Ich war hier" + gap-fill form interceptor
    rating.ts               Star-rating form interception
    logout.ts               Clears SW runtime cache before redirecting
    sheet.ts                Slide-over kiosk-detail sheet
    install-prompt.ts       iOS-Safari-only lazy-load of @khmyznikov/pwa-install
    app.css                 Tailwind v4 theme tokens + global styles
public/
  _headers                  Cache-Control rules consumed by Workers Assets
  sw.js                     Service worker (v5; 4 caches; /me, /moderate, /add, /auth pass through)
  logo-{180,512,1024}.png, icon-{192,512,512-maskable}.png,
  apple-touch-icon.svg, favicon.svg, manifest.webmanifest, og-1200x630.png, …
scripts/
  import-data.ts            Build-time data import from trinkhallen-data,
                            generates per-zoom supercluster snapshots
  write-asset-manifest.ts   Vite hashed-asset manifest → src/lib/manifest.generated.ts
android/
  Bubblewrap-generated Trusted Web Activity wrapper (package
  `app.trinkhallen.twa`). See android/PLAY_STORE.md for the Play Store
  submission playbook. Build artifacts (*.aab, *.apk, *.keystore) are
  gitignored; the upload keystore lives at ~/.android-keys/trinkhallen/.
migrations/
  0001_init.sql              users, sessions, ratings, reports, submissions
  0002_magic_links.sql       Magic-link login
  0003_moderation.sql        approved_by / approved_at / moderator_note
  0004_drop_kiosks.sql       Kiosks moved to static assets
  0005_indexes.sql           users(email), ratings(user_id)
  0006_checkins.sql          checkins table + extend reports.kind CHECK
  0007_username.sql          users.username + case-insensitive UNIQUE index
  0008_delete_ban.sql        Deletion sentinel user + users.banned_at shadow-ban
  0009_fix_ratings_kiosks_fk Rebuild ratings without the dangling kiosks FK
  0010_ph_observed_kind.sql  Rebuild reports with `ph_open_observed` kind +
                             allow status='approved' in CHECK
  0011_apple_sub.sql         users.apple_sub UNIQUE for Sign in with Apple
```

## Caching

Three layers, all aligned so a fresh deploy reaches users in seconds and
repeat visits cost nothing.

- **`public/_headers`** sets `Cache-Control` per Workers Assets path:
  `/assets/*` immutable forever (filenames are content-hashed),
  `/data/*` `max-age=300 + stale-while-revalidate=86400` (URLs stable
  across deploys; SWR carries through brief inconsistencies after a data
  push), `/sw.js` `max-age=0, must-revalidate`.
- **Service worker** (`public/sw.js`) has four named caches: `tk-static-vN`
  (cache-first), `tk-tiles-vN` (cache-first; OpenFreeMap style + glyphs +
  vector tiles), `tk-data-vN` (SWR for `/data/*`), `tk-runtime-vN` (SWR
  for the legacy bbox API + network-first for nav requests). Bump
  VERSION on breaking changes; old caches are dropped on activate.
- **Worker `caches.default`** for the legacy `/api/kiosks?bbox=` response,
  keyed by quantized bbox + filter signature.

## Basemap

[OpenFreeMap](https://openfreemap.org) — free hosted OpenMapTiles, no
API key. `src/client/build-style.ts` picks the style URL by theme
(`dark` or `positron`) and hands it to MapLibre, which fetches glyphs,
sprite, and vector tiles natively.

## Moderation

User-submitted reports and proposed kiosks land in D1 with status `open` /
`pending`. They become visible at `/moderate` to anyone with `role` ∈
`{moderator, admin}`.

Per item, moderators **Approve** or **Reject** with an optional reason note.
Approve triggers an auto-PR on `boredland/trinkhallen-data` via the GitHub
App, with the diff already applied to the right region file. Reject just
records the dismissal — the submitter sees the status on `/me`.

The GitHub App needs these permissions on `boredland/trinkhallen-data`:

| Permission | Level |
|---|---|
| Repository: Contents | Read & Write |
| Repository: Pull requests | Read & Write |
| Repository: Issues | Write |
| Repository: Metadata | Read |

Without those secrets, approvals still record the moderator decision in
D1 (status `approved`) and you can backfill PRs later — no data loss.

## License

- **Code**: AGPL-3.0-or-later.
- **Data** (in the separate `trinkhallen-data` repo): CC BY-NC 4.0.
