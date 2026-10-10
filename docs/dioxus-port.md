# Dioxus port — architecture contract

Branch `dioxus` replaces the Hono/TypeScript Worker with a Rust Worker that
renders Dioxus components on the server and hydrates interactive islands in
the browser. Production behaviour is the spec: every route, form, cookie,
redirect, header and D1 query of the TS app (as of `1bd4612`) must keep
working byte-compatibly with the live database and existing sessions.

## Why not `dioxus fullstack`

Dioxus fullstack's server (`dioxus-server`) is built on axum + tokio + hyper
and does not compile for `wasm32-unknown-unknown`. Cloudflare Workers run
wasm, so the server half is a `workers-rs` Worker that drives `dioxus-core`
and `dioxus-ssr` directly. Verified by spikes on 2026-10-10:

- `worker 0.8.7` + `dioxus 0.7.10` (no default features) + `dioxus-ssr` +
  `opening-hours 2.1.4` build for wasm32; `worker-build --release` produces a
  ~650 KB wasm. **`[profile.release]` must not set `strip = true`** — stripping
  removes the externref table and wasm-bindgen's abort-recovery wrappers fail.
- `dioxus-web` with the `hydrate` feature hydrates server-rendered islands. The
  server must emit, before the client bundle runs:
  `window.hydrate_queue=[];window.initial_dioxus_hydration_data="<b64>";`
  where `<b64>` is `dioxus_fullstack_core::HydrationContext` with only the error
  entry set (`ctx.error_entry().insert(&None::<CapturedError>, loc)`), i.e. the
  same serialization dioxus-server performs. Several islands can hydrate on one
  page (one `VirtualDom` + `dioxus_web::launch::launch_virtual_dom` per root id).
  SSR for an island uses `dioxus_ssr::pre_render` (emits hydration markers);
  non-interactive page chrome uses `dioxus_ssr::render` / `render_element`.

## Workspace layout (repo root)

```
Cargo.toml              workspace; [profile.release] lto, codegen-units=1, opt-level="z" (NO strip)
crates/
  core/                 trinkhallen-core: pure logic, no I/O, compiles native + wasm32
                        i18n (messages), geo, kind, filters, hours (week fast path +
                        opening-hours crate with DE Bundesland holidays), regions table,
                        navigate targets, usernames generator/validator, tags, report kinds,
                        kiosk record + GeoJSON types
  ui/                   trinkhallen-ui: Dioxus components shared by SSR + client
                        (Layout chrome, KioskList, KioskDetail, FilterChips, RatingBlock,
                        ReportForm, CheckinForm, LegalProse, profile/moderation views)
  worker/               trinkhallen-worker (cdylib): workers-rs entry, router, middleware
                        (security headers + CSP nonce, session, csrf, lang redirect),
                        D1 access, auth (Google OAuth, Apple, magic link, Turnstile),
                        moderation + GitHub App PRs, email, cron, asset-kiosks
  client/               trinkhallen-client (cdylib): dioxus-web hydration of islands +
                        browser behaviour (theme, filters, sidebar, sheet, checkin,
                        rating, logout, install prompt, SW registration, map glue)
  importer/             trinkhallen-importer (native bin): build-time data import
                        (regions.yml → dist/static/data/*, manifest, supercluster
                        summaries, flattened weeks, sitemap.xml, regions table)
web/
  map.js                MapLibre GL JS glue (map + pick), called from Rust via wasm-bindgen
  app.css               Tailwind v4 input (design tokens unchanged)
public/                 unchanged static files (sw.js, manifest, icons, _headers, …)
migrations/             unchanged D1 migrations — schema is NOT changed by the port
```

MapLibre stays JavaScript: there is no maintained Rust MapLibre binding for
the browser, and rewriting a WebGL map renderer is out of scope. Rust owns
everything around it (data loading, filtering, clustering inputs, events);
`web/map.js` is a thin, typed boundary (`mountMap`, `setFeatures`,
`mountPicker`, event callbacks).

## Build

```
cargo run -p trinkhallen-importer --release          # dist/static/data, sitemap, regions table
bunx @tailwindcss/cli -i web/app.css -o dist/static/assets/app.css --minify
wasm client: cargo build -p trinkhallen-client --target wasm32-unknown-unknown --release
             → wasm-bindgen --target web → wasm-opt -Oz → dist/static/assets/
worker:      worker-build --release (crates/worker) → build/
wrangler deploy
```

The CSS/JS bundling previously done by Vite is replaced by the Tailwind CLI
(class scanning over `crates/**/*.rs`) and esbuild for `web/map.js` +
maplibre-gl. Asset URLs are content-hashed by the build script and written to
a generated manifest the worker embeds (same role as `manifest.generated.ts`).

## Deploy

Cloudflare Workers Builds has no Rust toolchain. The build command installs it
(`rustup` minimal profile + wasm32 target, cached tools via `cargo binstall`),
keeping the existing Workers Builds trigger and the data-repo Deploy Hook
working unchanged. Fallback if build time exceeds the 20-minute limit: deploy
from GitHub Actions and point the data repo at a `repository_dispatch`.

## Invariants (must hold at cutover)

- D1 schema untouched; every SQL statement keeps its semantics.
- Session cookie `__Host-tk_sess` = `<sid>.<base64url(HMAC-SHA256(sid, SESSION_SECRET))>`,
  30-day sliding TTL — existing logged-in users stay logged in.
- Magic-link tokens: `<id>.<token>`, SHA-256 hex stored, 15-min TTL, ≤5 outstanding.
- All URLs, query params, redirects and form field names identical
  (`/`, `/en/*`, `/k/:id`, `/stadt/:slug`, `/about`, `/impressum`, `/datenschutz`,
  `/jetzt`, `/add`, `/me`, `/me/username`, `/me/delete`, `/moderate`, `/auth/*`,
  `/api/*`, `/.well-known/assetlinks.json`, `/list` → 301).
- Static assets (`/data/*`, `/sitemap.xml`, icons, `sw.js`) unchanged in path
  and cache headers; `public/_headers` stays authoritative.
- Security headers + nonce CSP equivalent to `src/index.ts`.
- Hourly cron reconciles `pr_opened` reports/submissions exactly as today.
