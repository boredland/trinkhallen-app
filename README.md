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
them; below zoom 9 a single `_summary.geojson` renders one bubble per region.

D1 stays small and holds only **user-generated content**:

| Table | What |
|---|---|
| `users`, `sessions`, `magic_links` | Auth (Google SSO + magic-link fallback) |
| `ratings` | 1–5 stars + optional comment, one per user per kiosk |
| `submissions` | Proposed new kiosks (form → moderator approval → PR) |
| `reports` | Edit requests on existing kiosks (form → moderator → PR or Issue) |

There is **no** `kiosks` table any more — the map, side panel, `/k/:id`, and
the `nearest`/bbox APIs all read from the static assets via
`src/lib/asset-kiosks.ts` (module-scope cache for the isolate lifetime).
Pushing to `boredland/trinkhallen-data` no longer touches D1; instead it
pokes a Cloudflare Deploy Hook so the next deploy rebuilds with fresh data.

## Local development

```sh
mise install                                # toolchains
pnpm install                                # also runs `lefthook install`
pnpm db:migrate:local                       # D1 schema for the user-gen tables
cp .env.example .dev.vars                   # any secrets you have
TRINKHALLEN_DATA_PATH=../trinkhallen-data pnpm build   # one-time, refreshes static data
pnpm preview                                # wrangler dev
```

`pnpm dev` (Vite + Miniflare) is also available if you need HMR; it expects
`dist/static/data/` to exist from a prior `pnpm build:data`.

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
pnpm db:migrate:remote
```

One-time operator setup:

```sh
# Cloudflare resources
wrangler d1 create trinkhallen-prod          # copy database_id into wrangler.toml
wrangler r2 bucket create trinkhallen-tiles

# Secrets (interactive prompts)
wrangler secret put SESSION_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_INSTALLATION_ID

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
  index.ts                Hono entry, middleware, route registration
  env.d.ts                Cloudflare bindings + Hono context types
  routes/
    pages.tsx             SSR pages (/, /about, /k/:id, /me, /add, /moderate)
    api.kiosks.tsx        Legacy fallback API — map reads /data/* directly
    api.ratings.tsx       Stars + comment writeback
    api.reports.tsx       "Daten falsch?" submission
    api.submissions.tsx   "Späti vorschlagen" submission
    auth.tsx              Google SSO + magic-link, session middleware
    moderate.tsx          /moderate UI + approve/reject endpoints
  lib/
    asset-kiosks.ts       Reads /data/*.geojson via env.ASSETS.fetch, caches per isolate
    db.ts                 KioskRecord shape (no D1 queries any more)
    filters.ts            Query-string ⇄ KioskFilter, applies on the server side
    ratings.ts, magic.ts, session.ts, moderation.ts, github*.ts, …
  client/
    map.entry.ts          MapLibre island
    region-store.ts       Fetches manifest + per-region geojsons, caches
    client-filters.ts     Client-side mirror of lib/filters.ts (fuse + opening_hours bundled)
    app.entry.ts          Alpine + filter form + sidebar collapse
    pick.entry.ts         /add flow's pickable map
public/
  _headers                Cache-Control rules consumed by Workers Assets
  sw.js                   Service worker (4 caches: static, tiles, data, runtime)
  manifest.webmanifest, marker-kiosk.svg, …
scripts/
  import-data.ts          Build-time data import from trinkhallen-data
  write-asset-manifest.ts Vite hashed-asset manifest → src/lib/manifest.generated.ts
migrations/
  0001_init.sql           users, sessions, ratings, reports, submissions
  0002_magic_links.sql    Magic-link login
  0003_moderation.sql     approved_by / approved_at / moderator_note
  0004_drop_kiosks.sql    Kiosks moved to static assets
  0005_indexes.sql        users(email), ratings(user_id)
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
  (cache-first), `tk-tiles-vN` (cache-first; PMTiles + Protomaps glyphs),
  `tk-data-vN` (SWR for `/data/*`), `tk-runtime-vN` (SWR for the legacy
  bbox API + network-first for nav requests). Bump VERSION on breaking
  changes; old caches are dropped on activate.
- **Worker `caches.default`** for the legacy `/api/kiosks?bbox=` response,
  keyed by quantized bbox + filter signature.

## Dark vector map (PMTiles)

Protomaps `BLACK` flavor served from `tiles.trinkhallen.app` (a Custom
Domain on the R2 bucket). MapLibre's `pmtiles://` protocol fetches the
header + directory + tile blobs via Range requests. If R2 is empty the
SSR check (`pmtilesAvailable()` in `src/lib/tiles-available.ts`)
transparently falls back to dimmed OSM raster.

To produce a Germany PMTiles file:

```sh
docker run --rm -v "$(pwd)":/data ghcr.io/onthegomap/planetiler:latest \
  --area=germany --download
mv data/output.pmtiles tmp/de.pmtiles

wrangler r2 object put trinkhallen-tiles/de.pmtiles \
  --file=tmp/de.pmtiles --remote --content-type=application/octet-stream
```

⚠️ `TILE_FILENAME` in `src/lib/tiles-available.ts` is unversioned (`de.pmtiles`).
The service worker caches it indefinitely, so a fresh upload won't reach
users automatically. When you regenerate tiles, either rename the file
(e.g. `de-YYYY-MM-DD.pmtiles`) and bump `TILE_FILENAME`, or bump the SW
`VERSION` constant to invalidate the cache.

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
