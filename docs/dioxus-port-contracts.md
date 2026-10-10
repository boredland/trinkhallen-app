# Dioxus port — slice contracts

Binding interfaces between the crates. Read `docs/dioxus-port.md` first.
The TypeScript sources under `src/` are the behavioural spec: port their
markup (classes, ids, `data-*` attributes, form field names, copy keys)
1:1 unless this file says otherwise. Do not change the D1 schema.

## crate `trinkhallen-core` (done)

Already implemented and tested; use it, do not duplicate its logic.
Key entry points: `i18n::{Lang, t, ts, tpl, path_for_lang, lang_from_path,
resolve_lang, tag_label, payment_label, report_kind_label, …}`,
`record::{KioskRecord, Feature, FeatureCollection, Manifest}`,
`hours::{compute_kiosk_status, compute_status, format_status,
format_hours_table, count_open_now, is_public_holiday, has_ph_token,
kiosk_state, flatten_week}`, `filters::{KioskFilter, parse_filter,
apply_filters, matches_structured, fuzzy_search, SearchDoc}`,
`geo::*`, `navigate::{build_navigate_targets, UaBucket}`,
`regions::{resolve_region_by_coords, resolve_region_by_slug, parse_prefix,
bundesland_for_region, REGIONS}`, `usernames::*`, `tags::*`, `reports::*`,
`kind::*`, `ORIGIN`.

## crate `trinkhallen-ui` (rlib; native + wasm32)

Dioxus components. **No I/O**, no `worker`/`web-sys` deps — pure props in,
`Element` out. Every type the worker passes in is defined here in
`trinkhallen_ui::model` (serde-serializable, so islands can receive props as
JSON). Rendering helpers live in `trinkhallen_ui::render`.

```rust
// model.rs — view models (owned by ui; the worker fills them from D1 / assets)
pub struct SessionUser { id, email, username: Option<String>, role: Role,
                         is_magic_link_only: bool, has_google: bool, has_apple: bool }
pub enum Role { User, Moderator, Admin }
pub struct Aggregate { count: u32, avg: f64 }            // ratings
pub struct RatingRow { stars: u8, comment: Option<String>, updated_at: i64 }
pub struct RatingComment { author: String, stars: u8, comment: String, updated_at: i64 }
pub struct UserKioskReport { id, kind, status, pr_url: Option<String>, created_at: i64 }
pub struct NearbyKiosk { id, name, district: Option<String>, distance: f64, lng, lat }
pub enum Nav { Map, About, Me, Moderate }

// render.rs
pub struct Page {                       // everything <head> + chrome needs
    pub lang: Lang, pub path: String,   // request path (drives hreflang/canonical/switcher)
    pub title: Option<String>, pub description: Option<String>,
    pub canonical_url: Option<String>, pub noindex: bool,
    pub json_ld: Vec<serde_json::Value>, pub nav: Nav,
    pub entries: Vec<ClientEntry>,      // which client bundles/CSS to load
    pub full_bleed: bool, pub user: Option<SessionUser>,
    pub nonce: String,                  // CSP nonce for inline scripts
    pub assets: AssetUrls,              // resolved, content-hashed URLs (see below)
    pub hydrate: bool,                  // emit hydration bootstrap globals
}
pub enum ClientEntry { App, Map, Pick }
pub struct AssetUrls { pub css: Vec<String>, pub client_js: String, pub client_wasm: String,
                       pub map_js: String }
/// Full HTML document: doctype + <html> + <head> + header/footer chrome +
/// `body` (already-rendered HTML of the page's main content).
pub fn document(page: &Page, body: String) -> String;
/// Render a static component tree to HTML (no hydration markers).
pub fn to_html(e: Element) -> String;
/// Render a hydratable island: returns `<div id="{root_id}" data-island="{name}"
/// data-props='{json}'>…pre-rendered markup…</div>`; the client rebuilds the same
/// component from `data-props` and hydrates it.
pub fn island<P: Serialize + Properties>(root_id: &str, name: &str, c: fn(P) -> Element, props: P) -> String;
```

### Islands (interactive components hydrated by the client)

Islands are the only Dioxus-reactive parts; everything else is static SSR.
Each island component lives in `trinkhallen_ui::islands`, takes one
serde-serializable props struct, and is registered by name in the client:

| name | component | replaces TS |
|---|---|---|
| `filters` | `FilterIsland` — chip form; on change rewrites URL, dispatches `tk:filters-changed`, refreshes the panel via `fetch` | `app.entry.ts` attachFilterForm, `FilterChips.tsx` |
| `rating` | `RatingIsland` — stars + comment, POST `/api/ratings`, swaps fragment | `client/rating.ts`, `RatingBlock.tsx` |
| `checkin` | `CheckinIsland` — "Ich war hier" + geolocation + gap-fill + signals | `client/checkin.ts`, `CheckinForm.tsx` |
| `report` | `ReportIsland` — kind select shows matching fieldset | `app.entry.ts` report form block, `ReportForm.tsx` |

Islands perform browser I/O through a tiny trait the client implements
(`trinkhallen_ui::islands::Browser`: `fetch_form(url, fields) -> (status, body)`,
`geolocate() -> Option<Coords>`, `replace_url(url)`, `dispatch(event, json)`),
injected with `use_context`. On the server the trait is a no-op stub; SSR
never triggers it (handlers only fire on user events).

**Hydration**: the server emits once per page, before the client module:
`<script nonce=…>window.hydrate_queue=[];window.initial_dioxus_hydration_data="{b64}";</script>`
where `{b64}` = `trinkhallen_ui::render::hydration_data()` (HydrationContext
with only the error entry). For multiple islands the client launches one
VirtualDom per `[data-island]` element. Island SSR uses `dioxus_ssr::pre_render`.

## crate `trinkhallen-worker` (cdylib, wasm32 via worker-build)

`#[event(fetch)]`, `#[event(scheduled)]`. Owns: routing, middleware
(secure headers + per-request CSP nonce identical to `src/index.ts`, session
cookie, csrf on the same path globs, language redirect/`setlang`, logger
optional), D1 queries (port SQL verbatim from `src/lib/*.ts` and
`src/routes/*.tsx`), auth (Google OAuth with state cookie checked
fail-closed, Apple form_post + ES256 client secret, magic link + Turnstile),
moderation + GitHub App (RS256 JWT → installation token → git data API
commit + PR/issue), email via `env.send_email("EMAIL")`, report notify via
`ctx.wait_until`, kiosks from `env.assets("ASSETS")` (`/data/_manifest.json`,
`/data/<slug>.geojson`, module-scope cache), the hourly reconcile cron.
Pages render through `trinkhallen_ui::render::document`.
Static assets are served by Workers Assets before the worker runs
(`public/_headers` keeps cache headers).

## crate `trinkhallen-client` (cdylib → wasm-bindgen --target web)

`#[wasm_bindgen(start)]`: hydrate every `[data-island]` with its component;
plus the non-island browser behaviour ported from `src/client/*.ts`
(theme toggle, sidebar collapse, data-back links, kiosk sheet open/close +
partial fetch + history, drag-to-dismiss, logout SW-cache purge, iOS install
prompt, service-worker registration + update toast, map glue). MapLibre stays
JS in `web/map.js`; the client calls it through `#[wasm_bindgen(module)]`
imports and feeds it features it loads/filters in Rust
(`/data/_manifest.json`, `_summary_z{5..8}.geojson`, region files,
`trinkhallen_core::filters`).

## crate `trinkhallen-importer` (native bin)

Port of `scripts/import-data.ts` + `scripts/write-asset-manifest.ts`:
regions.yml → `dist/static/data/*` (+ `week` flattening via
`trinkhallen_core::hours::flatten_week`, `visibleTotal` in the manifest),
supercluster-equivalent `_summary_z{5..8}.geojson`, `sitemap.xml`,
`crates/core/src/regions/generated.rs`; and the asset step: hash
`dist/static/assets/*` and write `crates/worker/src/assets_manifest.rs`.

## Asset layout (build output `dist/static/`)

```
assets/app-<hash>.css        Tailwind build of web/app.css (+ maplibre-gl.css)
assets/client-<hash>.js      wasm-bindgen glue (ES module)
assets/client_bg-<hash>.wasm optimized client wasm
assets/map-<hash>.js         esbuild bundle of web/map.js + maplibre-gl
assets/fonts/*               @fontsource woff2 files referenced by app.css
data/*, sitemap.xml          importer output
(public/* copied verbatim)
```
