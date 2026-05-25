# AGENTS.md

Load-bearing facts and footguns for this repo. Keep it terse.

## Architecture

Hono SSR app on a Cloudflare Worker. **Kiosk data is static** — per-region
GeoJSON files baked from `boredland/trinkhallen-data` into
`dist/static/data/` at build time. **D1 holds only user-generated content**:
auth, ratings, submissions, reports, check-ins, moderation. Map client +
SSR both read kiosks via `env.ASSETS.fetch` (helpers in
`src/lib/asset-kiosks.ts`). No runtime API to the data repo.

## Repo boundary

- **trinkhallen-data** — kiosks (OSM scrape, enrichment, schema, region
  bboxes, the GeoJSON itself). Edit there for *what's in* the dataset.
- **trinkhallen-app** (this repo) — presentation + UGC. Edit here for
  *how* kiosks are shown or *how* users interact.
- Only coupling: this repo's build clones the data repo. A data-repo
  push triggers a Cloudflare Deploy Hook (`CF_DEPLOY_HOOK_URL` secret
  on the data repo) which rebuilds this Worker.

## Deploys & migrations

- `git push main` → Cloudflare Workers Builds rebuilds + deploys.
- D1 migrations are **not** auto-applied. After landing one, run
  `bun run db:migrate:remote`.
- Pre-commit (lefthook): biome --write, tsc --noEmit, bun test —
  parallel, ~3 s. `--no-verify` bypasses; don't.

## Hot spots

- **`src/lib/asset-kiosks.ts`** caches the manifest + per-region records
  at module scope, invalidated only by a deploy. Don't sprinkle parallel
  fetch sites; go through the helpers.
- **`public/sw.js`** has a `VERSION` constant (v5 today). Any change to
  the cache strategy or the cached URL set must bump it. Auth-sensitive
  routes (`/me`, `/moderate`, `/add`, `/auth/*`) pass through; the SW
  used to cache them and any login transition flashed stale shell.
- **`public/_headers`** controls Workers Assets caching. New asset
  routes that need long caching go here, not as a Worker-set
  `Cache-Control` (that path is for D1-backed responses). Don't write
  hashed asset filenames — `/assets/*` glob already covers them.
- **D1 indexes**: `migrations/0005_indexes.sql` plus inline ones in
  later migrations. For new queries with non-PK `WHERE` clauses, add a
  covering index in a new migration.
- **Basemap is OpenFreeMap** (`src/client/build-style.ts`,
  `tiles.openfreemap.org`, no API key). No fallback today — if they
  go down, the map breaks.
- **`/.well-known/*` is served by Hono** (`src/routes/well-known.tsx`),
  not Workers Assets. Workers Assets has fragile handling for
  dot-prefixed dirs; Hono lets us set content-type + cache headers
  explicitly.
- **`android/` is a generated TWA wrapper.** Don't hand-edit the Java
  or Gradle files — edit `android/twa-manifest.json` and regenerate via
  `bubblewrap update`. Upload keystore lives at
  `~/.android-keys/trinkhallen/`; backup is on you.

## Don'ts

- **Don't add `/api/sync`.** Data flows at build time, not runtime.
  Want fresher data? Use the Deploy Hook.
- **Don't `SELECT FROM kiosks`.** No such table. `lib/asset-kiosks.ts`.
- **Don't `wrangler deploy` from CLI.** Pushes use stale local data and
  overwrite the proper build.
- **Don't mix Google Maps aggregate ratings into the `ratings` table.**
  Integer-stars CHECK + aggregate-vs-individual shape clash, and
  scraping cadence has its own ToS problems. If revisited, the right
  storage is a feature property on the GeoJSON (`google_rating`), not
  a D1 row.
- **Don't `--no-verify`.** Typecheck takes ~2 s; fix the type.
