# AGENTS.md

Orientation for LLM coding sessions. Skim this before touching the codebase
— it covers what's load-bearing, what looks innocuous but isn't, and the
"don't even think about it" list.

## Architecture in one paragraph

Hono SSR app on a Cloudflare Worker, runtime data split: kiosk data is
**static** (per-region GeoJSON files baked into `dist/static/data/` at
build time from `boredland/trinkhallen-data`), D1 holds only
user-generated content (auth, ratings, submissions, reports, moderation
metadata). The map client picks viewport-intersecting region files from a
manifest, the server reads the same assets via `env.ASSETS.fetch` for
`/k/:id` and the legacy bbox API. There is no `/api/sync` webhook any
more — data-repo pushes hit a Cloudflare Deploy Hook instead.

## Two repos, clear boundary

- **trinkhallen-data** owns kiosks. OSM scrape, enrichment, schema,
  region definitions, the GeoJSON itself. Modify here for anything about
  *what's in* the dataset.
- **trinkhallen-app** owns presentation + user-generated content.
  Modify here for anything about *how* kiosks are shown or *how* users
  interact with them.
- The only coupling: this repo's build downloads the data repo. There
  is no runtime API between them.

## Pre-commit

`bun install` triggers `lefthook install` (via the `prepare` script in
package.json). On every `git commit`:

- **biome check --write --files-ignore-unknown** on staged TS/TSX/JS/JSON,
  re-stages auto-fixes.
- **tsc --noEmit** on the whole project.

Both run in parallel; total overhead ~3s. To bypass in an emergency:
`git commit --no-verify`.

Biome config is in `biome.json`. Rule deviations vs. the recommended set
are documented in the rules object — don't expand the off-list without
a reason.

## Deploys

Cloudflare Workers Builds watches `main` and rebuilds on every push. The
build step shallow-clones `boredland/trinkhallen-data` to pick up the
latest GeoJSON before Vite runs.

Do **not** run `wrangler deploy` (or `bun run cf:deploy`) from the CLI. The
auto-deploy is the source of truth; a CLI push uses your local stale
trinkhallen-data and overwrites the proper build.

D1 migrations are **not** auto-applied. After landing a migration in
`migrations/`, run:

```sh
bun run db:migrate:remote
```

## Hot spots

- **`src/lib/asset-kiosks.ts`** keeps a **module-scope cache** of the
  manifest and per-region records, keyed off the Worker isolate's
  lifetime. Resetting this needs a deploy. Don't sprinkle additional
  fetch sites for the same data — go through the helpers.
- **`public/sw.js`** has a `VERSION` constant. Any breaking change to
  the cache strategy or the set of cached URLs must bump it; old caches
  are dropped on `activate`. Forgetting the bump leaves users on the
  previous behaviour forever.
- **`public/_headers`** is read by Workers Assets. New asset routes that
  need long caching go here (not as a `Cache-Control` set from the
  Worker — that path is for D1-backed responses).
- **D1 indexes** live in `migrations/0005_indexes.sql`. When adding a
  query with a `WHERE` on a column that isn't a PK, check that an index
  covers it.
- **Basemap is OpenFreeMap** (`src/client/build-style.ts`) — hosted at
  `tiles.openfreemap.org`, no API key. If they go down, the map breaks
  with no fallback today. Adding a fallback would be a Workers KV /
  in-Assets style JSON that points at a raster source.

## Don'ts

- **Don't add `/api/sync`.** The webhook is gone; data flows via build
  step, not at runtime. If you find yourself wanting a runtime data
  refresh, the right answer is the Cloudflare Deploy Hook.
- **Don't query D1 for kiosk content.** No `SELECT FROM kiosks` —
  there is no such table. Use `lib/asset-kiosks.ts`.
- **Don't run `wrangler deploy` from CLI.** Push to `main` and let
  Builds do it.
- **Don't write hashed asset filenames to `public/_headers`** (the
  `/assets/*` glob already covers them; per-file entries are dead weight
  and easy to forget when filenames rehash).
- **Don't `--no-verify` to skip the typecheck.** If something doesn't
  typecheck, the deployed build won't either. (The hook is fast — fix
  the type instead.)
- **Don't mix Google Maps ratings into the `ratings` D1 table.** See
  decision log entry 2026-05-21.

## Decision log

- **2026-05-20 — D1 kiosks dropped.** Kiosks moved from a D1 table fed by
  a GitHub webhook to per-region static GeoJSON baked at build time.
  Reasoning: every D1 read was a flat passthrough of the geojson, so
  D1 added a runtime hop without value. Static + SWR is faster, simpler,
  and removes the failure mode of "webhook missed a commit."
- **2026-05-20 — Cross-repo deploy hook.** Cloudflare Workers Builds
  watches the app repo only; data-repo pushes therefore can't trigger a
  redeploy on their own. A workflow in trinkhallen-data
  (`.github/workflows/deploy-app.yml`) POSTs to a Cloudflare Deploy
  Hook URL stashed as `CF_DEPLOY_HOOK_URL`. Path filter restricts to
  `data/**`, `regions.yml`, `schema/**` so doc-only PRs don't trigger.
- **2026-05-20 — OSM cross-region dedup.** trinkhallen-data PR #11 added
  an `ownsFeature` rule in the OSM scraper that picks the closest-anchor
  region for each Overpass result. Side effect: bbox overlap in
  `regions.yml` is now safe; a new region's bbox can be generous.
- **2026-05-21 — Google Maps ratings: deferred indefinitely.** Considered
  scraping aggregate ratings via gosom/google-maps-scraper for ~12k
  features. Storage shape would have been a feature property
  `google_rating: { avg, count, fetched_at }` (not a synthetic user
  row — the integer-stars CHECK constraint and aggregate-vs-individual
  mismatch made that a non-starter). Scrapped because the cadence
  needed for useful coverage (≥1000 queries/hour) escalates the project
  from the existing accepted "tens per month" ToS posture to a
  meaningfully harder one — rate limits, CAPTCHA gates, possible IP
  block — without enough user-visible payoff yet. Revisit when (a)
  community ratings remain too sparse to be useful, AND (b) we're
  willing to pay for Google Places API access (~€17/1000 requests,
  ToS-clean).
- **2026-05-21 — Switched basemap to OpenFreeMap, dropped custom map
  markers.** Stopped self-hosting PMTiles in R2 + the Protomaps style
  layer. Point MapLibre at `tiles.openfreemap.org/styles/{dark|positron}`,
  let it fetch tiles/glyphs/sprite natively. Removed
  `@protomaps/basemaps` and `pmtiles` deps, `src/lib/tiles-available.ts`,
  `public/style-night.json`, and the per-kiosk SVG markers
  (`marker-kiosk.svg`, `marker-gas.svg`). Unclustered features are now
  plain coloured circles. The vending-machine filter (lib/kind.ts) stays
  — that's still functional value. Trade-off: third-party dependency on
  OpenFreeMap's uptime; no fallback today.
- **2026-05-21 — Per-zoom supercluster snapshots replace the flat
  `_summary.geojson`.** `scripts/import-data.ts` now runs supercluster
  over every non-vending kiosk and emits `_summary_z5..z8.geojson`. The
  map binds one source per integer zoom band so clusters visibly refine
  as the user zooms 5→9 instead of jumping from "one bubble per region"
  to "real clusters" at the DETAIL_ZOOM boundary. `DETAIL_ZOOM` stays
  at 9; per-region detail behaviour unchanged.
- **2026-05-22 — Gap-fill on visit + silent check-in logging.** New
  "Ich war hier" affordance on `/k/:id` (`src/components/CheckinForm.tsx`)
  surfaces 1–3 chip-style questions targeted at fields the kiosk is
  missing. Answers fan out as individual reports through the existing
  moderation pipeline; three new report kinds (`update_payment`,
  `update_tags`, `wrong_name`) landed in migration 0006 alongside the
  `checkins` event table. Gamification (leaderboard, streaks) is
  explicitly out of V1 — see memory
  `feature-scoping-defer-ui-capture-data` — but the schema is shaped
  so a future leaderboard query is one COUNT(*) WHERE verified=1 away.
- **2026-05-22 — Set-once `users.username` + transparent magic-link →
  Google merge.** `upsertUser` in `src/routes/auth.tsx` now falls back to
  email lookup; if it finds a row whose `google_sub` starts with the
  synthetic `email:` prefix it upgrades that row in place instead of
  creating a duplicate. No new "Link Google" route — the existing button
  on the login page handles signup, sign-in, and linking. `username` is
  slug-shaped (`^[a-z0-9_]{3,24}$`), set-once via
  `UPDATE … WHERE username IS NULL` (`src/lib/usernames.ts`), and
  surfaces on `/me` as a one-time form + static `@handle` display.
- **2026-05-22 — Service worker bypasses `/me`, `/moderate`, `/add`,
  `/auth/*`.** The SW used to pre-warm `/me` at install and
  stale-while-revalidate every navigation. Any auth transition
  (magic-link sent, email-link verified, Google sign-in, logout)
  flashed whichever snapshot was cached until a hard reload reconciled
  state. Per-user / auth-sensitive paths now pass through; VERSION
  bumped to v5 to drop the old `tk-runtime-v4` cache. `logout.ts`
  additionally purges `tk-runtime-*` before navigating home so the
  cached logged-in shell doesn't paint after sign-out.
- **2026-05-22 — Header user button identity hierarchy.** The previous
  fallback rendered the email local-part ("info" / "IJ"), which read
  as junk for magic-link signups. The new button ranks identities
  strictly: `username` → mono `@handle` in neon-cyan,
  `displayName` → first name in Anton uppercase,
  neither → sober "Profil" label with a small amber-square corner cue
  indicating "incomplete identity". Avatars lose `rounded-full` to
  match the brutalist look. See `src/components/Layout.tsx` `UserButton`.
- **2026-05-22 — Impressum + Datenschutz pages.** German legal pages
  added at `/impressum` (§5 TMG) and `/datenschutz` (DSGVO Art. 13).
  Linked from the footer, included in `sitemap.xml`. Required for
  the Google OAuth consent screen in Published mode and standard
  practice for any public German site.

### Cross-repo decisions (trinkhallen-data)

- **2026-05-22 — Gmaps payment timeout-resilience.** The
  `run-gmaps-payment.ts` script in the data repo now incrementally
  flushes each modified geojson and traps SIGTERM (sent ~5 min before
  the runner's job-timeout SIGKILL). Combined with `--max-runtime-min
  300`, a `payment_attempted` 30-day negative cache, and `if: always()`
  on the follow-up `Detect changes` + `Open PR` steps in the bulk
  workflow, a timed-out region now opens a PR with whatever partial
  progress it flushed instead of dying silently. See trinkhallen-data
  PR #64 and #83.
- **2026-05-22 — Store real `place_id` in `sources[]` instead of the
  `"payment"` placeholder.** gosom already returns `place_id` / `cid` /
  `data_id`; the payment script now stores the canonical id so future
  enrichments can hit a place directly without re-searching by
  name+coords. Upgrade-in-place handles legacy placeholder rows on the
  next enrichment touch — no separate backfill. trinkhallen-data PR
  #93.
- **2026-05-22 — Separate `id-resolve` workflow** for Google + Apple
  place-ids, decoupled from data enrichment. New
  `scripts/run-id-resolve.ts` with two independent slots (gosom for
  Google, DuckDuckGo `local.js` for Apple — `provider_meta.apple.place_id`
  in the response). Apple coverage is uneven for tiny German kiosks
  (DDG's local index is thinner there); unresolved features get a
  30-day `{gmaps,apple}_id_attempted` stamp. trinkhallen-data PR #96.

When adding a new entry: date it, name what changed, say why, and link
the PR/commit if relevant. Keep entries terse — this list is a memory
aid, not project history.
