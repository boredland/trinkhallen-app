# Architecture

A Rust Worker renders Dioxus components on the server and hydrates the
interactive parts as islands in the browser.

## Why not `dioxus fullstack`

Dioxus fullstack's server (`dioxus-server`) is built on axum + tokio + hyper
and does not compile for `wasm32-unknown-unknown`. Cloudflare Workers run
wasm, so the server half is a `workers-rs` Worker that drives `dioxus-core`
and `dioxus-ssr` directly.

- **`[profile.release]` must not set `strip = true`** — stripping removes the
  externref table and wasm-bindgen's abort-recovery wrappers fail.
- `dioxus-web` with the `hydrate` feature hydrates server-rendered islands. The
  server emits, before the client bundle runs:
  `window.hydrate_queue=[];window.initial_dioxus_hydration_data="<b64>";`
  where `<b64>` is `dioxus_fullstack_core::HydrationContext` with only the error
  entry set — the same serialization dioxus-server performs. Several islands
  hydrate on one page (one `VirtualDom` + `launch_virtual_dom` per root).
  Island SSR uses `dioxus_ssr::pre_render` (emits hydration markers);
  non-interactive chrome uses `dioxus_ssr::render` / `render_element`.
- Island props travel as JSON in `data-props`, not through server futures, so
  the hydration payload stays a fixed constant.
- A controlled `textarea` binds its text via `value`, never a text child: once
  the user types, the browser owns the text node and a patch against it panics.

## Workspace layout

```
Cargo.toml              workspace; [profile.release] lto, codegen-units=1, opt-level="z" (NO strip)
crates/
  core/                 trinkhallen-core: pure logic, no I/O, compiles native + wasm32
                        i18n catalog, geo, kind, filters (Fuse-compatible search),
                        hours (baked week fast path + opening_hours.js-compatible
                        evaluator, opening-hours crate for the rest, DE Bundesland
                        holidays), regions table, kiosk record + GeoJSON types
  ui/                   trinkhallen-ui: Dioxus components shared by SSR + client
                        pages/, components/ (layout, kiosk list + detail),
                        islands/ (filters, rating, check-in, report)
  worker/               trinkhallen-worker (cdylib): workers-rs entry, router, middleware
                        (security headers + CSP nonce, session, csrf, lang redirect),
                        D1 access, auth (Google OAuth, Apple, magic link, Turnstile),
                        moderation + GitHub App PRs, email, cron, asset kiosks
  client/               trinkhallen-client (cdylib): island hydration + browser behaviour
                        (theme, sidebar, sheet, panel refresh, logout, install prompt,
                        SW registration, map glue)
  importer/             trinkhallen-importer (native bin): build-time data import
                        (regions.yml → dist/static/data/*, manifest, supercluster
                        summaries, baked weeks, sitemap.xml, regions table) and
                        client-bundle hashing
web/
  map.js                MapLibre GL JS glue (map + /add picker), driven via wasm-bindgen
  pwa.js                Lazy iOS install prompt
  app.css               Tailwind v4 input (design tokens)
public/                 static files (sw.js, manifest, icons, _headers, …)
migrations/             D1 migrations
```

MapLibre stays JavaScript: there is no maintained Rust MapLibre binding for
the browser. Rust owns everything around it (data loading, filtering,
events); `web/map.js` is a thin boundary (`mountMap`, `setDetailFeatures`,
`setSummary`, `mountPicker`, `tk:*` events).

Opening hours: the site evaluated hours with opening_hours.js for years, and
OSM data is tuned to it. `crates/core/src/hours/weekly.rs` reproduces its
semantics for the rule subset nearly every kiosk uses; the `opening-hours`
crate handles the rest (month ranges, sun events, school holidays). At
cutover the two agreed on 17,792 of 17,794 baked weeks and 1,474 of 1,495
runtime statuses; the remainder are sun-event rules (the crate uses fixed
times) and syntax opening_hours.js rejects.

## Build

One script, used locally, in CI and by Workers Builds:
`bash scripts/build-dioxus.sh`. It bootstraps Rust 1.98.1 + `worker-build`
and the JS build dependencies when missing, then:

1. `trinkhallen-importer data` → `dist/static/data/*`, `sitemap.xml`
   (`TRINKHALLEN_DATA_PATH` points at a local data checkout; otherwise a
   shallow clone under `.tmp/`).
2. `crates/client/build.sh` → client wasm (wasm-bindgen + wasm-opt), esbuild
   bundles of `web/map.js` / `web/pwa.js`, Tailwind CSS, fonts.
3. `trinkhallen-importer assets` moves that bundle to
   `dist/static/assets/<hash>/` (hash over every file) and writes
   `crates/worker/src/assets_manifest.rs` (gitignored; `build.rs` writes an
   empty placeholder so `cargo check` works on a fresh clone). The bundle is
   hashed as one directory because its files import each other relatively.
4. `public/` copied over, then `worker-build --release` → `crates/worker/build/`.

Cold build in the Workers Builds image: about three minutes, toolchain
install included.

Local: `bun run dev` (`wrangler dev`, which runs the build and rebuilds on
changes under `crates/*/src`, `web/` and `public/`).

## Tests

- `cargo test --workspace` — unit tests per crate.
- `bun run test:e2e` — Playwright against `wrangler dev`: public pages,
  authed flows with seeded sessions, every island, moderation gate.

## Invariants

- Session cookie `__Host-tk_sess` = `<sid>.<base64url(HMAC-SHA256(sid, SESSION_SECRET))>`,
  30-day sliding TTL, attribute order fixed — existing sessions must keep working.
- Magic-link tokens: `<id>.<token>`, SHA-256 hex stored, 15-min TTL, ≤5 outstanding.
- URLs, query params, redirects and form field names are public API (links,
  bookmarks, the Android/iOS wrappers): `/`, `/en/*`, `/k/:id`,
  `/stadt/:slug`, `/about`, `/impressum`, `/datenschutz`, `/jetzt`, `/add`,
  `/me`, `/me/username`, `/me/delete`, `/moderate`, `/auth/*`, `/api/*`,
  `/.well-known/assetlinks.json`, `/list` → 301.
- `public/_headers` stays authoritative for static caching; everything under
  `/assets/` must be content-addressed.
- Responses read back from `caches.default` have immutable headers — go
  through `http::mutable` before adding any.
- Hourly cron reconciles `pr_opened` reports/submissions against GitHub.
