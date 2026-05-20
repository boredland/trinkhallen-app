# trinkhallen.app

A finder for German **Trinkhallen**, **Wasserhäuschen** and **Spätis** — built on Cloudflare Workers + Hono.
The data lives openly on GitHub at [`trinkhallen-data`](https://github.com/trinkhallen/trinkhallen-data) (to be created).

> Inspired by [HopfenStop](https://app.hopfenstop.de/) (CC BY-NC 4.0). Data extended via OpenStreetMap (ODbL).
> trinkhallen.app is **non-commercial**.

## Implementation plan

The full plan is at [`/home/jonass/.claude-work/plans/i-want-to-create-composed-deer.md`](../.claude-work/plans/i-want-to-create-composed-deer.md).
Short version: Hono SSR + JSX, MapLibre GL JS island, Protomaps PMTiles on R2, D1 with `rtree` for spatial queries, Google SSO via `@hono/oauth-providers`, GitHub App for the submission/report PR workflow.

## Local development

```sh
# 1. Install runtimes (uses ./mise.toml)
mise install

# 2. Install deps
pnpm install

# 3. Create the local D1 database & run migrations
pnpm db:migrate:local

# 4. Copy env template and fill in any secrets you have
cp .env.example .dev.vars

# 5. Start dev server (Vite SSR + Worker via Miniflare)
pnpm dev
```

Dev server runs at <http://localhost:5173> (Vite) — proxied through `@hono/vite-dev-server`, so the Hono app handles all routes.

## Deploy

The first deploy is operator-only; afterwards CI does it.

```sh
# 1. One-time: create the Cloudflare resources
wrangler d1 create trinkhallen-prod          # copy database_id into wrangler.toml
wrangler r2 bucket create trinkhallen-tiles

# 2. Set secrets (interactive prompts)
wrangler secret put SESSION_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_INSTALLATION_ID
wrangler secret put GITHUB_WEBHOOK_SECRET

# Promote yourself (after first login) so /moderate becomes accessible.
# The user row is created on first magic-link or Google login.
wrangler d1 execute trinkhallen-prod --remote --command \
  "UPDATE users SET role='moderator' WHERE email='you@example.com'"

# 3. Apply migrations to the real DB
pnpm db:migrate:remote

# 4. Upload the Germany PMTiles to R2 (one-time, refresh quarterly)
#    See the "Dark vector map" section below for build options.
wrangler r2 object put trinkhallen-tiles/de.pmtiles --file ./tmp/de.pmtiles --remote

# 5. Deploy
pnpm deploy
```

## Repository layout

```
src/
  index.ts                Hono entry, route registration
  env.d.ts                Cloudflare bindings + Hono context types
  routes/
    pages.tsx             SSR pages (/, /list, /about, /k/:id, /me)
    api.kiosks.ts         (slice 2) bbox-keyed kiosk lookup
    api.ratings.ts        (slice 5)
    api.reports.ts        (slice 7)
    api.submissions.ts    (slice 7)
    api.sync.ts           (slice 2) GitHub webhook → D1 upsert
    auth.ts               (slice 4) Google SSO
  components/             Hono JSX components
  lib/                    db, github, session, opening-hours, navigate, geo
  client/
    app.css               Tailwind v4 + Späti Neon @theme
    entry.ts              Alpine + HTMX bootstrap
    map.entry.ts          MapLibre island (loaded only on /)
migrations/
  0001_init.sql           initial D1 schema
```

## Dark vector map (PMTiles)

The app uses the **Protomaps `BLACK` basemap flavor** (via `@protomaps/basemaps`)
served from a Germany-only PMTiles file in R2. The Worker route `/tiles/:filename`
proxies range requests against the `TILES` bucket so MapLibre's `pmtiles://`
protocol can fetch directory + tile blobs incrementally.

If R2 is empty, the SSR check (`pmtilesAvailable()`) silently falls back to
dimmed OSM raster — the site stays functional during a missing or stale upload.

### One-time setup

Get a Germany PMTiles file. The cleanest path is to run
[planetiler](https://github.com/onthegomap/planetiler) against a Germany OSM
extract from Geofabrik:

```sh
# Roughly 10–30 minutes on a laptop with 8+ GB RAM
docker run --rm -v "$(pwd)":/data ghcr.io/onthegomap/planetiler:latest \
  --area=germany --download

# Output is /data/data/output.pmtiles (≈ 1–2 GB)
mv data/output.pmtiles tmp/de.pmtiles
```

Alternative: use `pmtiles extract` (from
[`go-pmtiles`](https://github.com/protomaps/go-pmtiles)) to pull a Germany
slice from a worldwide PMTiles host:

```sh
pmtiles extract https://example.com/world.pmtiles tmp/de.pmtiles \
  --bbox=5.87,47.27,15.04,55.06 --maxzoom=14
```

Then upload to R2:

```sh
wrangler r2 object put trinkhallen-tiles/de.pmtiles \
  --file=tmp/de.pmtiles --remote --content-type=application/octet-stream
```

The site auto-detects on the next render (cached for ~60 s via
`caches.default`); no redeploy required.

## Moderation

User-submitted reports and proposed kiosks land in D1 with status `open` /
`pending`. They become visible at `/moderate` to anyone with `role` ∈
`{moderator, admin}`.

Per item, moderators **Approve** or **Reject** with an optional reason note.
Approve triggers an auto-PR on `boredland/trinkhallen-data` via the GitHub
App, with the diff already applied to the right region file. Reject just
records the dismissal — submitter sees the status on `/me`.

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
