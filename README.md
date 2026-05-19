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

# 3. Apply migrations to the real DB
pnpm db:migrate:remote

# 4. Upload the Germany PMTiles to R2 (one-time, refresh quarterly)
#    Download from https://maps.protomaps.com/builds/ then:
wrangler r2 object put trinkhallen-tiles/de.pmtiles --file ./tmp/de.pmtiles

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

## License

- **Code**: AGPL-3.0-or-later.
- **Data** (in the separate `trinkhallen-data` repo): CC BY-NC 4.0.
