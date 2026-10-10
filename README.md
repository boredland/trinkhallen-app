# trinkhallen.app

A finder for German **Trinkhallen**, **Wasserhäuschen** and **Spätis** — Rust + [Dioxus](https://dioxuslabs.com) on Cloudflare Workers.
The data lives openly at [`boredland/trinkhallen-data`](https://github.com/boredland/trinkhallen-data).

> Inspired by [HopfenStop](https://app.hopfenstop.de/) (CC BY-NC 4.0). Data extended via OpenStreetMap (ODbL).
> trinkhallen.app is **non-commercial**.

## Architecture

A Rust Worker ([workers-rs](https://github.com/cloudflare/workers-rs))
renders every page with Dioxus SSR; interactive parts (filters, rating,
check-in, report form) are Dioxus islands hydrated by a wasm client, and the
map is MapLibre GL JS driven from that client. Kiosk data is **static**: the
trinkhallen-data repo is shallow-cloned at build time and its per-region
`data/<state>/<city>.geojson` files are copied into `dist/static/data/`,
served via the Workers Assets binding. The client picks the files
intersecting the viewport from a manifest and unions them; below zoom 9 four
pre-baked supercluster snapshots (`_summary_z5..z8.geojson`) drive a refined
per-zoom overview without loading any region files.

See [`docs/architecture.md`](docs/architecture.md) for the crate layout,
build and invariants.

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
`crates/worker/src/assets.rs` (module-scope cache for the isolate lifetime).
Pushing to `boredland/trinkhallen-data` no longer touches D1; instead it
pokes a Cloudflare Deploy Hook so the next deploy rebuilds with fresh data.

## Local development

```sh
mise install                                # bun, Rust 1.98.1 + wasm32 target
bun install                                 # also runs `lefthook install`
bun run db:migrate:local                    # D1 schema for the user-gen tables
cp .env.example .dev.vars                   # any secrets you have
TRINKHALLEN_DATA_PATH=../trinkhallen-data bun run dev   # build + wrangler dev
```

`bun run dev` runs the full build (`scripts/build-dioxus.sh`) and rebuilds
when `crates/`, `web/` or `public/` change. Without `TRINKHALLEN_DATA_PATH`
the build shallow-clones trinkhallen-data into `.tmp/`.

Tests: `bun run test` (Rust unit tests), `bun run test:e2e` (Playwright
against `wrangler dev`). Pre-commit runs biome, rustfmt and the Rust tests via
lefthook. To bypass in an emergency: `git commit --no-verify`.

## Deploy

Cloudflare Workers Builds watches `main` and deploys on every push, with
these settings (dashboard → trinkhallen-app → Settings → Build):

| Setting | Value |
|---|---|
| Build command | `bash scripts/build-dioxus.sh` |
| Deploy command | `npx wrangler deploy` |

The build installs Rust into the (Rust-less) build image on first run; a cold
build takes about three minutes. Do **not** run `wrangler deploy` from the
CLI — the Builds run pulls trinkhallen-data fresh; an out-of-band CLI deploy
uses whatever stale snapshot is on your disk.

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
crates/
  core/       Pure domain logic (native + wasm32): i18n catalog, opening hours
              (baked week fast path + evaluator, DE Bundesland holidays),
              filters + fuzzy search, regions table, kiosk records, usernames
  ui/         Dioxus components shared by SSR and the client:
              pages/ (one module per route), components/ (layout, kiosk list
              + detail), islands/ (filters, rating, check-in, report)
  worker/     The Cloudflare Worker: routes/, auth/ (Google, Apple, magic
              link + Turnstile), moderation/ (GitHub App PRs), session, csrf,
              D1 access, email, the hourly reconcile cron
  client/     Browser wasm: island hydration, sheet, map glue, service worker
              registration, install prompt
  importer/   Build-time: trinkhallen-data → dist/static/data (+ supercluster
              summaries, sitemap, regions table); content-hashes the client
              bundle into dist/static/assets/<hash>/
web/
  app.css     Tailwind v4 theme tokens + global styles
  map.js      MapLibre GL JS glue (map + /add picker), driven from the client
  pwa.js      Lazy iOS-Safari install prompt (@khmyznikov/pwa-install)
public/
  _headers    Cache-Control rules consumed by Workers Assets
  sw.js       Service worker (4 caches; /me, /moderate, /add, /auth pass through)
  logo-{180,512,1024}.png, icon-{192,512,512-maskable}.png,
  apple-touch-icon.svg, favicon.svg, manifest.webmanifest, og-1200x630.png, …
scripts/
  build-dioxus.sh       The build (local, CI, Workers Builds)
  gen-holidays-rs.ts    Regenerates crates/core/src/hours/holidays_de.rs
tests/e2e/              Playwright suite against `wrangler dev`
android/
  Bubblewrap-generated Trusted Web Activity wrapper (package
  `app.trinkhallen.twa`). See android/PLAY_STORE.md for the Play Store
  submission playbook. Build artifacts (*.aab, *.apk, *.keystore) are
  gitignored; the upload keystore lives at ~/.android-keys/trinkhallen/.
migrations/   D1 schema (0001_init … 0015_field_signals); see the files
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
- **Worker `caches.default`** for the `/api/kiosks?bbox=` response,
  keyed by quantized bbox + filter signature.

## Basemap

[OpenFreeMap](https://openfreemap.org) — free hosted OpenMapTiles, no
API key. `web/map.js` picks the style URL by theme (`dark` or `positron`)
and hands it to MapLibre, which fetches glyphs, sprite, and vector tiles
natively.

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
