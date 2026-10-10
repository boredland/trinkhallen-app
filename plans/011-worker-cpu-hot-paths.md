# Plan 011: Cut Worker CPU on `/about`, `/api/kiosks/nearest` and the map panel

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- scripts/import-data.ts src/lib/asset-kiosks.ts src/lib/asset-kiosks.test.ts src/routes/api.kiosks.tsx src/routes/pages.tsx src/lib/collate.ts src/routes/panel-cache.test.ts tests/e2e/fixtures/data/_manifest.json README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none (if plan 009 landed first, `scripts/import-data.ts`
  will also contain `writeRegionsModule`; that is expected and does not
  conflict)
- **Category**: perf
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

The project pays Cloudflare per Worker CPU-millisecond, and three hot routes do
far more work per request than their output needs:

1. **`/about`** shows one number — how many kiosks are on the map — and computes
   it on every request by fetching and parsing **all 74 region files** (~10.9 MB
   of GeoJSON, 17.8k features) via `countKiosks`. The number only changes on
   deploy. Observed live: 0.64–1.40 s per request.
2. **`/api/kiosks/nearest`** (called once when a user taps "locate me") does a
   linear scan over **all 74 regions** to find a single nearest kiosk, even
   though the answer is almost always in the user's own region. Observed:
   0.83–1.47 s.
3. **`/api/kiosks/panel`** returns the map's side list and fires on **every
   pan and zoom** (200 ms debounce). It has **no caching at all** — no
   `Cache-Control`, no `caches.default` — unlike its sibling `/api/kiosks`,
   which already uses an edge-cache pattern. Each call queries up to 5,000
   records, filters, sorts by name with `localeCompare`, counts open kiosks, and
   renders 100 rows (~100 KB HTML).

The isolate-level caches (`regionRecordsCache`) help warm isolates but
Cloudflare spreads traffic across many short-lived isolates, so cold work
recurs constantly.

After this plan: `/about` reads a precomputed total from the manifest (no region
files), `nearest` searches outward from the user and stops early, and the panel
response is cached at the edge for 60 s using the same pattern `/api/kiosks`
already uses. Name sorting switches to a shared `Intl.Collator` (same order,
≈3.7× faster in a local benchmark on Frankfurt's 1,473 names).

## Current state

### `/about` — `src/routes/pages.tsx:625-631`

```tsx
  app.get("/about", async (c) => {
    const lang = langFromPath(c.req.path);
    const [total, ratings, users] = await Promise.all([
      countKiosks(c.env),
      countRatings(c.env),
      countUsers(c.env),
    ]);
```

### `countKiosks` — `src/lib/asset-kiosks.ts:167-175`

```ts
export async function countKiosks(env: Env): Promise<number> {
  // Count from the loaded region records (not the manifest sum) so the figure
  // matches what users actually see — vending-only entries are excluded.
  const manifest = await loadManifest(env);
  const all = await Promise.all(manifest.regions.map((r) => recordsForRegion(env, r.slug)));
  let n = 0;
  for (const rs of all) for (const r of rs) if (r.kind !== "vending") n++;
  return n;
}
```

"Vending" comes from `classifyKind` in `src/lib/kind.ts` — `dataKind ===
"vending_machine"` **or** a name regex (JIMA, Selecta, Sielaff, "Automaten-Kiosk",
…). The manifest's `count` is `features.length` (includes vending). Today's
data: 17,794 features, 17,715 visible, 79 vending (60 by `kind`, 19 by name
regex). So a visible count must use `classifyKind`, not just the `kind` field.

### Manifest emission — `scripts/import-data.ts:129, 162-168, 170-176, 181`

```ts
  const manifest: Array<{ slug: string; prefix: string; bbox: Region["bbox"]; count: number }> = [];
  …
    manifest.push({
      slug: region.slug,
      prefix: region.prefix,
      bbox: region.bbox,
      count: features.length,
    });

    for (const f of features) {
      const props = f.properties as { id?: string; kind?: string; updated?: string };
      if (props.kind === "vending_machine") continue;
      allOverviewFeatures.push(f);
      …
    }
  …
  writeFileSync(`${OUT_DIR}/_manifest.json`, JSON.stringify({ regions: manifest }));
```

The server reads it as `interface Manifest { regions: ManifestEntry[] }`
(`src/lib/asset-kiosks.ts:17-26`); the client reads `regions` too
(`src/client/region-store.ts:17-22, 47-56`). Adding a **top-level** field is
backwards compatible for both.

The e2e fixture manifest `tests/e2e/fixtures/data/_manifest.json` is used when no
real dataset is built:

```json
{
  "regions": [
    { "slug": "frankfurt", "prefix": "fr", "bbox": [8.6, 50.08, 8.72, 50.14], "count": 3 }
  ]
}
```

### `findNearestKiosk` — `src/lib/asset-kiosks.ts:216-240`

```ts
/**
 * Closest kiosk to `origin` across the whole dataset. Loads every region file
 * once (cached for the isolate lifetime). For ~12 k features this is on the
 * order of a few ms after the first call.
 */
export async function findNearestKiosk(env: Env, origin: { lat: number; lng: number }): Promise<{ record: KioskRecord; distance: number } | null> {
  const manifest = await loadManifest(env);
  const all = await Promise.all(manifest.regions.map((r) => recordsForRegion(env, r.slug)));
  let best: KioskRecord | null = null;
  let bestDist = Infinity;
  for (const records of all) {
    for (const r of records) {
      if (r.kind === "vending") continue; // never recommend an automat as "nearest"
      const d = haversineMeters(origin, { lat: r.lat, lng: r.lng });
      if (d < bestDist) { bestDist = d; best = r; }
    }
  }
  return best ? { record: best, distance: bestDist } : null;
}
```

Region bboxes contain their features (checked against today's data: 2 of
17,794 features sit marginally outside their region's bbox). Treat the bbox as
a **hint for ordering**, not a guarantee — the algorithm below stays exact even
for those outliers because it only *prunes* a region when its bbox is provably
farther than the current best, and the prune uses a safety margin.

### `/api/kiosks/panel` — `src/routes/api.kiosks.tsx:66-109`

```tsx
apiKiosks.get("/api/kiosks/panel", async (c) => {
  const url = new URL(c.req.url);
  const lang = resolveLang(url.searchParams.get("lang") ?? c.req.header("accept-language"));
  const bbox = parseBbox(url.searchParams.get("bbox"));
  const origin = parseLatLng(url.searchParams.get("origin"));
  if (!bbox)
    return c.html(<KioskList lang={lang} kiosks={[]} totalInBbox={0} filteredCount={0} userAgent={null} />);
  const filter = parseFilterFromQuery(url.searchParams);
  const all = await queryKiosksInBbox(c.env, bbox, 5000);
  const filtered = applyFilters(all, filter);
  if (origin) {
    filtered.sort((a, b) => haversineMeters(origin, a) - haversineMeters(origin, b));
  } else {
    filtered.sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  const now = new Date();
  const openNowCount = countOpenNow(filtered, now);
  return c.html(
    <KioskList lang={lang} kiosks={filtered.slice(0, 100)} totalInBbox={all.length}
      filteredCount={filtered.length} openNowCount={openNowCount} filterActive={isFilterActive(filter)}
      resetHref={pathForLang("/", lang)} origin={origin ?? undefined}
      userAgent={c.req.header("user-agent") ?? null} />,
  );
});
```

What the output depends on, and therefore what a cache key must include:

| Input | Why it matters |
|---|---|
| `lang` | all copy |
| `bbox` | which kiosks |
| filter (`pay`, `tags`, `open_now`, `needs_hours`, `q`) | which kiosks |
| `origin` | sort order + distance labels (`KioskList.tsx:126-128`) |
| User-Agent | the primary "navigate" button per row: iOS → Apple Maps, Android → `geo:`, else Google Maps web (`src/lib/navigate.ts:53-60`) |
| current time | open/closed pills and the open-now count |

The proven cache pattern to copy is right above it in the same file,
`src/routes/api.kiosks.tsx:36-63`:

```ts
  const filter = parseFilterFromQuery(new URL(c.req.url).searchParams);
  const sig = filterSignature(filter);
  const qb = quantizeBbox(bbox, 0.01);
  const cacheKey = new Request(
    `https://cache.trinkhallen.app/kiosks?b=${qb.west},${qb.south},${qb.east},${qb.north}&l=${limit}&f=${sig}`,
    { method: "GET" },
  );
  const cache = (caches as unknown as { default: Cache }).default;
  // Filter signature changes invalidate; open_now changes minute-by-minute,
  // so we skip cache for it.
  const cacheable = !filter.openNow;
  if (cacheable) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  …
  const resp = new Response(body, { headers: { "content-type": "…", "cache-control": "public, max-age=60, s-maxage=60" } });
  if (cacheable) c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
```

`quantizeBbox` and `filterSignature` already exist (`src/lib/geo.ts:72-81`,
`src/lib/filters.ts:20-31`). The client sends raw `map.getBounds()` floats
(`src/client/map.entry.ts:351-353`), so quantizing is what makes hits possible.

### Name sort call sites

`src/routes/api.kiosks.tsx:92`, `src/routes/pages.tsx:233` and
`src/routes/pages.tsx:517` all do `.sort((a, b) => a.name.localeCompare(b.name, "de"))`.
Each `localeCompare` call with a locale argument re-resolves the locale. A shared
`new Intl.Collator("de")` gives the identical order (verified on Frankfurt's
names) at ~0.9 ms vs ~3.3 ms per 1,473-name sort in Bun.

### Test patterns

- `src/lib/asset-kiosks.test.ts` — fixtures keyed by asset path, a stub
  `env.ASSETS.fetch` that counts fetches per path (lines 115-142). Module-level
  caches persist across tests in the same file, so **each test uses distinct
  region slugs** (comment at lines 5-6). `loadManifest` caches the first
  manifest it sees for the whole file — any new manifest field must be added to
  the single `"/data/_manifest.json"` fixture, not a second manifest.
- Route tests drive `app.request(…)` (see `src/routes/csrf-coverage.test.ts`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Focused   | `bun test src/lib/asset-kiosks.test.ts` | all pass |
| Tests     | `bun test` | all pass |
| Lint      | `bun run lint` | exit 0 |
| Data      | `TRINKHALLEN_DATA_PATH=../trinkhallen-data bun run build:data` | ends `Done. 74 regions, …` |
| E2E       | `bun run test:e2e` | all pass (CI; optional locally) |

## Scope

**In scope** (the only files you should modify):

- `scripts/import-data.ts` — add `visibleTotal` to the manifest
- `src/lib/asset-kiosks.ts` — `countKiosks`, `findNearestKiosk`, `Manifest` type
- `src/lib/asset-kiosks.test.ts`
- `src/routes/api.kiosks.tsx` — panel caching, collator; stale `nearest` comment
- `src/routes/pages.tsx` — the two `localeCompare` sorts only (lines 233, 517)
- `src/lib/collate.ts` (create) — the shared collator
- `src/routes/panel-cache.test.ts` (create) — panel cache tests
- `tests/e2e/fixtures/data/_manifest.json` — add `visibleTotal`
- `README.md` — the "Caching" section (lines 186-202)

**Out of scope** (do NOT touch):

- Edge-caching full SSR HTML pages (`/`, `/stadt/*`, `/k/*`). Those carry
  session-dependent chrome and set cookies; caching them is a separate design.
- `src/client/**` and `public/sw.js` — no client or service-worker change.
- `/api/kiosks?bbox=` and `/api/kiosks/nearest-open` — leave as they are.
- `src/lib/filters.ts`, `src/lib/opening-hours.ts` — no algorithm changes.
- The `logger()` middleware in `src/index.ts`.

## Git workflow

- Branch: `advisor/011-worker-cpu-hot-paths`
- One commit per step group, conventional style matching
  `perf(kiosks): drop the raw FeatureCollection cache, keep only records`:
  1. `perf(about): read the visible kiosk total from the manifest`
  2. `perf(nearest): search outward by region distance and stop early`
  3. `perf(panel): edge-cache the side-panel fragment for 60 s`
  4. `perf(sort): share one Intl.Collator for German name sorting`
- Do NOT push or open a PR.

## Steps

### Step 1: Bake `visibleTotal` into the manifest

In `scripts/import-data.ts`:

1. Import `classifyKind` from `"../src/lib/kind"` (the script already imports
   from `../src/lib/hours-week` and `../src/lib/messages`, so this is an
   established pattern).
2. Keep a running `let visibleTotal = 0;` and, inside the per-region feature
   loop, increment it when
   `classifyKind({ name: props.name, dataKind: props.kind }) !== "vending"`.
   Widen the local `props` cast to include `name?: string`.
   Do **not** change the existing `kind === "vending_machine"` skip used for
   the overview clusters and sitemap — that is a separate, deliberate rule.
3. Write `{ visibleTotal, regions: manifest }` instead of `{ regions: manifest }`.
4. Add a comment saying why: `/about` shows this number and must not parse every
   region file per request to get it; it uses `classifyKind` so it matches
   what the map and lists hide.

Update `tests/e2e/fixtures/data/_manifest.json` to
`{ "visibleTotal": 3, "regions": [ … unchanged … ] }` — but first open
`tests/e2e/fixtures/data/frankfurt.geojson` and count its non-vending features;
use that number, not 3, if it differs.

**Verify**: run the Data command → exit 0; then
`bun -e 'console.log((await Bun.file("dist/static/data/_manifest.json").json()).visibleTotal)'`
→ prints a number between 17,000 and 19,000 (17,715 at planning time). If you
cannot run the Data command (no data checkout and no network), skip this verify
and say so.

### Step 2: `countKiosks` reads the manifest

In `src/lib/asset-kiosks.ts`:

1. Add `visibleTotal?: number;` to `interface Manifest` with a one-line doc
   comment.
2. Rewrite `countKiosks`: if `manifest.visibleTotal` is a finite number, return
   it; otherwise fall back to the current full scan (keeps an old or
   hand-built manifest working). Rewrite the comment: why the manifest value is
   preferred (no region parsing on a page view) and when the fallback runs.

Tests in `src/lib/asset-kiosks.test.ts`:

- Add `visibleTotal` to the existing `"/data/_manifest.json"` fixture, with a
  value that **cannot** equal the real visible count of the fixtures (e.g.
  `4242`).
- `it("countKiosks returns the manifest's visibleTotal without fetching region files")`:
  call `countKiosks(env)` with a fresh `createStubEnv()`; expect `4242`, and
  expect `fetchCounts` to contain no path ending in `.geojson`.

  Because `loadManifest` caches per test file, the fallback branch cannot be
  tested here without a second manifest. Do not add one — note in your report
  that the fallback is exercised only by an old manifest.

**Verify**: `bun test src/lib/asset-kiosks.test.ts` → all pass.

### Step 3: `findNearestKiosk` searches outward and stops early

Replace the body of `findNearestKiosk` with this algorithm (keep the signature
and return shape):

1. Load the manifest. For each region compute `lower(r)`, a **lower bound** in
   meters on the distance from `origin` to any point inside its bbox:
   clamp `origin` into the bbox (`clampLng = min(max(origin.lng, w), e)`, same
   for lat) and take `haversineMeters(origin, clamped)`. A point inside the bbox
   has lower bound 0.
2. Sort regions ascending by `lower`.
3. Walk them in order. Before loading a region, if
   `lower(r) > bestDist + 1000` (1 km safety margin for features sitting just
   outside their bbox), **stop** — no remaining region can beat the best.
   Otherwise `await recordsForRegion(env, r.slug)` and scan it as today
   (skipping `vending`).
4. Return the best as today.

Rewrite the function's doc comment: the region bbox is a lower bound on
distance, so regions are visited nearest-first and the search ends when the next
region's bound exceeds the best distance found (plus a margin, because a few
features sit just outside their region's bbox).

Tests in `src/lib/asset-kiosks.test.ts` (use the existing fixtures: `region-a`
bbox `[8,50,9,51]` with kiosks at `(8.5,50.5)` and `(8.6,50.6)`, `region-d`
bbox `[14,50,15,51]`):

- `it("findNearestKiosk returns the closest non-vending kiosk")`: origin
  `{ lat: 50.5, lng: 8.5 }` → id `tk_ra_001`, distance `< 1`.
- `it("findNearestKiosk does not load regions that cannot contain a closer kiosk")`:
  same origin, fresh stub env → after the call, `fetchCounts` has no entry for
  `/data/region-d.geojson` (≈ 400 km away).
- `it("findNearestKiosk ignores vending machines")`: origin
  `{ lat: 50.55, lng: 14.55 }` (exactly on `tk_rd_002`, "Inside Vending") →
  returns `tk_rd_001`, not `tk_rd_002`.

  Module-level caches persist across tests: a region already loaded by an
  earlier test is not re-fetched. For the "does not load" test, assert on
  `region-d` only if no earlier test in the file loaded it; if one did, assert
  on a region none of the earlier tests touch, or move the test to run first,
  and say which you did.

Also replace the stale comment above the route at
`src/routes/api.kiosks.tsx:118-121` ("O(n) scan — for ~2k rows it's
microseconds …") with one sentence pointing at `findNearestKiosk`'s
nearest-first search.

**Verify**: `bun test src/lib/asset-kiosks.test.ts` → all pass.

### Step 4: Edge-cache `/api/kiosks/panel`

In `src/routes/api.kiosks.tsx`, restructure the panel handler following the
`/api/kiosks` pattern above:

1. Keep the `!bbox` early return as is (uncached).
2. Derive cache-key parts:
   - `qb = quantizeBbox(bbox, 0.01)` **and use `qb` for the query too**
     (`queryKiosksInBbox(c.env, qb, 5000)`) so the cached body matches its key.
     Before using `qb`, check it is still a valid box
     (`qb.west < qb.east && qb.south < qb.north`); if quantizing collapsed a
     tiny box, fall back to the raw `bbox` and skip caching.
   - `sig = filterSignature(filter)`
   - `ua = uaBucket(c.req.header("user-agent"))` where
     `uaBucket` returns `"ios" | "android" | "other"` using the **same regexes**
     as `pickPrimary` in `src/lib/navigate.ts:57-58`
     (`/iphone|ipad|ipod/` then `/android/` on the lower-cased UA). Define
     `uaBucket` locally in `api.kiosks.tsx` (`navigate.ts` is out of scope),
     with a comment that it must mirror `pickPrimary`.
   - `lang`
3. `cacheable = !filter.openNow && !origin`. Origin-sorted panels are skipped:
   the distance labels vary per user location, so a shared cache would show
   wrong distances. (The origin variant only fires after a user geolocates.)
4. Cache key URL:
   `https://cache.trinkhallen.app/panel?b=${qb.west},${qb.south},${qb.east},${qb.north}&f=${encodeURIComponent(sig)}&l=${lang}&u=${ua}`.
5. If cacheable, `cache.match(key)` → return on hit.
6. Render as today, but pass a **representative UA string** for the bucket to
   `KioskList` instead of the raw header, so every response stored under a
   bucket renders identically: `"iphone"` for `ios`, `"android"` for `android`,
   `null` for `other`. (`buildNavigateTargets` only inspects these substrings.)
7. Build the response with `c.html(...)`, then set
   `Cache-Control: public, max-age=60, s-maxage=60` on it; if cacheable,
   `c.executionCtx.waitUntil(cache.put(key, resp.clone()))`.
8. Write a comment explaining the key: which inputs vary the HTML, why
   `open_now` and `origin` bypass the cache, and that the open/closed pills can
   be up to 60 s stale (same trade-off `/api/kiosks` already makes).

Route test — the panel is a route, so create a new file
`src/routes/panel-cache.test.ts`. It needs `caches.default`, `env.ASSETS` and
an execution context:

- Install a fake `globalThis.caches = { default: { match, put } }` backed by a
  `Map<string, Response>` keyed by `request.url`; restore the original in
  `afterEach`. (Bun's test runtime has no `caches` global; check with
  `typeof caches` first and restore whatever was there.)
- Reuse a minimal ASSETS stub: a manifest with one region and a feature
  collection of 2-3 kiosks (copy the shape from `asset-kiosks.test.ts`, but use
  **new slugs/prefixes** — this is a different test file, so its module caches
  are separate from `asset-kiosks.test.ts`, yet `loadManifest` is cached for
  this file's lifetime).
- Pass `{ waitUntil: (p) => pending.push(p), passThroughOnException() {} }`
  as the 4th `app.request` argument and `await Promise.all(pending)` before
  asserting on the cache.

Cases:

1. A plain request → 200, `cache-control` contains `s-maxage=60`, and one
   entry was `put` into the fake cache.
2. The same request again → served from cache: the stub's region-file fetch
   count does not increase.
3. Two bboxes that differ only below the 0.01° grid → one cache entry.
4. `open_now=1` → no `put`.
5. `origin=50.1,8.6` → no `put`.
6. iPhone UA and desktop UA → two different cache keys; the iPhone response
   contains `maps://` and the desktop one does not.
7. `lang=en` and `lang=de` → two different keys.

**Verify**: `bun test src/routes/panel-cache.test.ts` → 7 pass;
`bun test` → all pass.

### Step 5: Shared collator for German name sorting

1. Create `src/lib/collate.ts`:

```ts
/**
 * One shared German collator. `a.localeCompare(b, "de")` re-resolves the
 * locale on every comparison; on the panel/sidebar sorts (up to 5,000 names
 * per request) a reused Intl.Collator gives the same order several times
 * faster.
 */
export const compareDe = new Intl.Collator("de").compare;
```

2. Replace the three sorts:
   `src/routes/api.kiosks.tsx:92`, `src/routes/pages.tsx:233`,
   `src/routes/pages.tsx:517` →
   `.sort((a, b) => compareDe(a.name, b.name))`.

**Verify**: `grep -rn 'localeCompare' src/` → no matches;
`bun test` → all pass (existing sidebar ordering tests, if any, must stay green).

### Step 6: Docs

Update `README.md` "Caching" (lines 186-202): the "Worker `caches.default`"
bullet currently names only the legacy `/api/kiosks?bbox=` response. Add the
panel fragment and its key (quantized bbox + filter signature + lang + UA
bucket; `open_now`/`origin` bypass), and one line noting `/about`'s kiosk total
comes from `_manifest.json`'s `visibleTotal`.

**Verify**: `grep -n 'visibleTotal' README.md` → one match;
`grep -n 'panel' README.md` → at least one match in the Caching section.

### Step 7: Measure (before/after evidence)

Locally, with a real data build in `dist/static/data` (Step 1's Data command):

1. `bun run build` then `bun run preview` (wrangler dev, serves
   `http://localhost:8787`).
2. Measure each route five times **after one warm-up request**, before and
   after the change (stash your changes or use the base branch for "before"):
   - `curl -s -o /dev/null -w '%{time_total}\n' http://localhost:8787/about`
   - `curl -s -o /dev/null -w '%{time_total}\n' 'http://localhost:8787/api/kiosks/nearest?origin=50.11,8.68'`
     — use a **fresh** `wrangler dev` process for the first nearest call in
     each run, since isolate caches make the second call cheap either way.
   - `curl -s -o /dev/null -w '%{time_total}\n' 'http://localhost:8787/api/kiosks/panel?lang=de&bbox=8.6,50.1,8.7,50.15'`
3. Report a small before/after table. This is evidence, not a pass/fail gate:
   if a number got worse, say so.

If you cannot run `wrangler dev` locally, say so and skip; the unit tests are
the gate.

## Test plan

- `src/lib/asset-kiosks.test.ts`: `countKiosks` uses `visibleTotal` and fetches
  no region file; `findNearestKiosk` correctness, early stop (a far region is
  never fetched), and vending exclusion.
- `src/routes/panel-cache.test.ts` (new): 7 cases covering cache store/hit,
  grid quantization, the `open_now`/`origin` bypasses, UA buckets, and locale
  separation.
- Patterns: fixture/stub style of `src/lib/asset-kiosks.test.ts:8-142`;
  app-level requests like `src/routes/csrf-coverage.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck`, `bun run lint`, `bun test` all exit 0
- [ ] `grep -n 'visibleTotal' scripts/import-data.ts src/lib/asset-kiosks.ts tests/e2e/fixtures/data/_manifest.json`
      matches in all three files
- [ ] `grep -rn 'localeCompare' src/` returns no matches
- [ ] `grep -n 'cache.trinkhallen.app/panel' src/routes/api.kiosks.tsx` matches
- [ ] `src/routes/panel-cache.test.ts` exists with 7 passing tests
- [ ] `git status --short` lists only in-scope files (plus `plans/README.md`)
- [ ] Mutation checks, report each: (a) make `countKiosks` ignore
      `visibleTotal` → the countKiosks test fails; (b) remove the early-stop
      `break` in `findNearestKiosk` → the "does not load" test fails;
      (c) drop the UA bucket from the cache key → panel case 6 fails. Revert all.
- [ ] Step 7 measurements reported (or explicitly skipped with a reason)
- [ ] `plans/README.md` status row for 011 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `KioskList` (or anything it renders) turns out to read the session, cookies,
  or any per-user value besides the props listed above — then the panel is not
  safely shareable and the cache key is incomplete.
- The panel response sets a cookie (inspect `set-cookie` in test case 1). A
  response with `Set-Cookie` must never be put in a shared cache.
- `caches.default` is not available under `bun run preview` (wrangler dev) and
  the existing `/api/kiosks` route also fails there — report; do not add
  feature-detection hacks beyond what `/api/kiosks` already does.
- Switching to `Intl.Collator` changes any existing test's expected order.
- `findNearestKiosk` returns a different kiosk than the old full scan for any
  origin you try (spot-check 3-4 real origins against a build of the base
  branch, e.g. Frankfurt, Berlin, Vienna, a rural point). The early stop must be
  exact.

## Maintenance notes

- **Cache-key invariant**: any new input to the panel's HTML (a new filter,
  a new per-UA tweak, personalisation) must join the cache key or bypass the
  cache. A reviewer should check this on every change to `KioskList` or the
  panel route.
- The panel and `/api/kiosks` caches are not purged on deploy; a fresh deploy's
  data reaches panels within 60 s. Same as today for `/api/kiosks`.
- `visibleTotal` is computed by the importer with `classifyKind`; if the vending
  classification rules change, the number follows automatically on the next
  build.
- Not done here, and the next lever if CPU is still high: edge-caching the SSR
  pages for anonymous visitors (`/stadt/*`, `/k/*`, `/`), which needs a
  cookie-aware bypass and is a larger design.
