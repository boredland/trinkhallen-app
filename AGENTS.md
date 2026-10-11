# AGENTS.md

Load-bearing facts and footguns for this repo. Keep it terse.

## Architecture

Rust Worker (workers-rs) rendering Dioxus SSR; interactive bits are Dioxus
islands hydrated by a wasm client. Crate map and invariants:
`docs/architecture.md`. **Kiosk data is static** — per-region GeoJSON files
baked from `boredland/trinkhallen-data` into `dist/static/data/` at build
time. **D1 holds only user-generated content**: auth, ratings, submissions,
reports, check-ins, moderation. Map client + SSR both read kiosks via
`env.ASSETS.fetch` (`crates/worker/src/assets.rs`). No runtime API to the
data repo.

## Repo boundary

- **trinkhallen-data** — kiosks (OSM scrape, enrichment, schema, region
  bboxes, the GeoJSON itself). Edit there for *what's in* the dataset.
- **trinkhallen-app** (this repo) — presentation + UGC. Edit here for
  *how* kiosks are shown or *how* users interact.
- Only coupling: this repo's build clones the data repo. A data-repo
  push triggers a Cloudflare Deploy Hook (`CF_DEPLOY_HOOK_URL` secret
  on the data repo) which rebuilds this Worker.

## Deploys & migrations

- `git push main` → Cloudflare Workers Builds runs
  `bash scripts/build-dioxus.sh` and deploys.
- D1 migrations are **not** auto-applied. After landing one, run
  `bun run db:migrate:remote`.
- Pre-commit (lefthook): biome, rustfmt, `cargo test --workspace`.
  `--no-verify` bypasses; don't.

## Hot spots

- **`crates/worker/src/assets.rs`** caches the manifest + per-region
  records at module scope, invalidated only by a deploy. Don't sprinkle
  parallel fetch sites; go through the helpers.
- **`public/sw.js`** has a `VERSION` constant (v9 today). Any change to
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
- **Basemap is OpenFreeMap** (`web/map.js`, `tiles.openfreemap.org`, no
  API key). No fallback today — if they go down, the map breaks.
- **Mail goes through Cloudflare Email Service**
  (`crates/worker/src/email.rs`): the `send_email` binding with a
  structured message, no hand-rolled MIME. Always send `text` alongside
  `html`. The `from` domain must stay onboarded
  (`wrangler email sending list`).
- **Report emails are fire-and-forget** (`crates/worker/src/notify.rs`).
  Every new `reports` row pings `REPORT_NOTIFY_TO` via `ctx.wait_until`,
  never awaited — a broken mail hop must not fail a user's report. The
  recipient MUST be a *verified* Email Routing destination address or the
  binding throws `E_RECIPIENT_NOT_ALLOWED`. Unset disables the mails. Both
  insert sites (the report form handler and the PH auto-file in the
  check-in handler) call it; a third insert site must too.
- **`/.well-known/*` is served by the Worker**
  (`crates/worker/src/routes/well_known.rs`), not Workers Assets. Workers
  Assets has fragile handling for dot-prefixed dirs; the Worker sets
  content-type + cache headers explicitly.
- **Opening hours must match opening_hours.js.** The live site evaluated
  them with that library for years; `crates/core/src/hours/weekly.rs`
  reproduces its semantics for the common rule subset (the `opening-hours`
  crate disagrees on overnight spill, comments and spellings). Check
  changes against `opening_hours` (a devDependency) before trusting them.
- **Never set `strip = true`** in `[profile.release]`: it removes the
  externref table and wasm-bindgen's abort-recovery wrappers fail.
- **Client panics surface only as `unreachable`** without
  `console_error_panic_hook` — keep it installed in `startup.rs`.
- **`android/` is a generated TWA wrapper.** Don't hand-edit the Java
  or Gradle files — edit `android/twa-manifest.json` and regenerate via
  `bubblewrap update`. Upload keystore lives at
  `~/.android-keys/trinkhallen/`; backup is on you.

## Don'ts

- **Don't add `/api/sync`.** Data flows at build time, not runtime.
  Want fresher data? Use the Deploy Hook.
- **Don't `SELECT FROM kiosks`.** No such table. `crates/worker/src/assets.rs`.
- **Don't `wrangler deploy` from CLI.** Pushes use stale local data and
  overwrite the proper build.
- **Don't mix Google Maps aggregate ratings into the `ratings` table.**
  Integer-stars CHECK + aggregate-vs-individual shape clash, and
  scraping cadence has its own ToS problems. If revisited, the right
  storage is a feature property on the GeoJSON (`google_rating`), not
  a D1 row.
- **Don't `--no-verify`.** Fix the failing check.
