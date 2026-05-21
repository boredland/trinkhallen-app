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

`pnpm install` triggers `lefthook install` (via the `prepare` script in
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

Do **not** run `wrangler deploy` (or `pnpm cf:deploy`) from the CLI. The
auto-deploy is the source of truth; a CLI push uses your local stale
trinkhallen-data and overwrites the proper build.

D1 migrations are **not** auto-applied. After landing a migration in
`migrations/`, run:

```sh
pnpm db:migrate:remote
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
- **`src/lib/tiles-available.ts:TILE_FILENAME`** is unversioned. Re-
  uploading the PMTiles bundle without changing the name traps users on
  stale tiles via the SW cache — bump the filename (and the constant)
  when you regenerate.

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

When adding a new entry: date it, name what changed, say why, and link
the PR/commit if relevant. Keep entries terse — this list is a memory
aid, not project history.
