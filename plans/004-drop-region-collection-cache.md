# Plan 004: Stop retaining raw GeoJSON collections after deriving kiosk records

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 498bbb5..HEAD -- src/lib/asset-kiosks.ts`
> If `src/lib/asset-kiosks.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `498bbb5`, 2026-08-16

## Why this matters

`src/lib/asset-kiosks.ts` keeps **two** module-scope caches of the same data:
`regionCache` holds the raw parsed `FeatureCollection` per region, and
`regionRecordsCache` holds the `KioskRecord[]` derived from it. Module scope on
a Cloudflare Worker means these live for the whole isolate lifetime.

The raw collections have no reader once the records exist. `loadRegion` is
called from exactly one place — `recordsForRegion` — which immediately maps it
to records and caches those separately. Nothing else in the codebase reads
`regionCache`.

Measured against the real built dataset in `dist/static/data` (74 region files,
17 794 features, 10.9 MB of JSON):

- both caches retained: **24.3 MB**
- records only: **14.3 MB**
- dead weight: **≈10 MB**

That is ~10 MB of an isolate's memory budget held for nothing. It matters
because several code paths load **every** region: `countKiosks` (rendered on
`/about`) and `findNearestKiosk` (`GET /api/kiosks/nearest`) both iterate
`manifest.regions` and call `recordsForRegion` for each, so a single request to
either warms all 74 regions and pins the full footprint.

The module-scope caching itself is the documented, intentional design
(`AGENTS.md`) — this plan does not change that. It removes a redundant second
copy of data that is already cached in a more useful form.

## Current state

File: `src/lib/asset-kiosks.ts` — the only server-side reader of the static
kiosk data. 247 lines.

The two caches, `src/lib/asset-kiosks.ts:50-53`:

```ts
let manifestCache: Manifest | null = null;
let prefixToSlug: Map<string, string> | null = null;
const regionCache = new Map<string, FeatureCollection>();
const regionRecordsCache = new Map<string, KioskRecord[]>();
```

`loadRegion`, `src/lib/asset-kiosks.ts:75-82` — the only writer/reader of
`regionCache`:

```ts
async function loadRegion(env: Env, slug: string): Promise<FeatureCollection> {
  let c = regionCache.get(slug);
  if (!c) {
    c = await fetchJson<FeatureCollection>(env, `/data/${slug}.geojson`);
    regionCache.set(slug, c);
  }
  return c;
}
```

`recordsForRegion`, `src/lib/asset-kiosks.ts:118-126` — the only caller of
`loadRegion`:

```ts
async function recordsForRegion(env: Env, slug: string): Promise<KioskRecord[]> {
  let rs = regionRecordsCache.get(slug);
  if (!rs) {
    const collection = await loadRegion(env, slug);
    rs = collection.features.map((f) => featureToRecord(slug, f));
    regionRecordsCache.set(slug, rs);
  }
  return rs;
}
```

`featureToRecord`, `src/lib/asset-kiosks.ts:84-104`, is what derives a record.
Note it copies scalars but **shares** the nested objects (`address`, `hours`,
`payment`, `sources`, `tags`) by reference with the parsed feature. Those shared
subobjects are retained by the records either way — that is already accounted
for in the 14.3 MB figure, and it is why dropping `regionCache` frees the
feature envelopes and geometry, not the whole 10.9 MB.

The all-regions paths that make this footprint real:

- `countKiosks`, `src/lib/asset-kiosks.ts:174-182` — used by `/about`
  (`src/routes/pages.tsx:628`).
- `findNearestKiosk`, `src/lib/asset-kiosks.ts:228-247` — used by
  `GET /api/kiosks/nearest` (`src/routes/api.kiosks.tsx:127`).

Repo conventions:

- `AGENTS.md` is explicit: "**`src/lib/asset-kiosks.ts`** caches the manifest +
  per-region records at module scope, invalidated only by a deploy. Don't
  sprinkle parallel fetch sites; go through the helpers." Note it describes the
  cache as holding **records** — the raw-collection cache is the undocumented
  extra. Your change brings the code in line with the documented design.
- Comments explain **why**.

## Commands you will need

| Purpose   | Command             | Expected on success        |
|-----------|---------------------|----------------------------|
| Install   | `bun install`       | exit 0                     |
| Typecheck | `bun run typecheck` | exit 0, no output          |
| Tests     | `bun test`          | all pass (114 before this plan) |
| Lint      | `bun run lint`      | exit 0, "No fixes applied" |
| Build     | `bun run build`     | exit 0 (needs the data repo; see Step 3) |

## Scope

**In scope** (the only files you should modify):

- `src/lib/asset-kiosks.ts`
- `src/lib/asset-kiosks.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `regionRecordsCache` — keep it. It is the documented, load-bearing cache.
- `manifestCache` / `prefixToSlug` — tiny and correct.
- Adding cache eviction, an LRU, or a size cap — that is a different design
  decision with real tradeoffs (a deploy already invalidates everything), and
  bundling it here would obscure a clean removal.
- `src/client/region-store.ts` — the browser-side loader. It has its own
  `loadRegion` with different semantics (promise-keyed, avoids duplicate
  in-flight fetches). Do not "unify" them.
- Changing `featureToRecord`'s sharing of nested objects into deep copies. That
  would *increase* memory, not reduce it.

## Git workflow

- Branch: `advisor/004-drop-region-collection-cache`
- One commit. Message style from `git log`: `chore: drop unused alpinejs +
  htmx.org deps` is the closest precedent. Use:
  `perf(kiosks): drop the raw FeatureCollection cache, keep only records`
- Do NOT push or open a PR.

## Steps

### Step 1: Remove the redundant cache

In `src/lib/asset-kiosks.ts`:

1. Delete the `regionCache` declaration (line 52).
2. Rewrite `loadRegion` so it just fetches and returns the collection with no
   caching — or inline the fetch into `recordsForRegion` and delete `loadRegion`
   entirely. **Prefer inlining**: a one-line private helper with a single caller
   and no caching earns nothing, and `fetchJson` already exists as the shared
   fetch path.
3. Add a short comment on `regionRecordsCache` explaining *why* only the derived
   records are cached: the raw collection has no other reader, and holding both
   doubled the per-isolate footprint (~10 MB across the current dataset) for no
   benefit.

Behaviour must be unchanged: same records, same cache semantics for records,
same fetch path via `fetchJson`.

**Verify**:
- `grep -n 'regionCache' src/lib/asset-kiosks.ts` → no matches
- `bun run typecheck` → exit 0
- `bun test` → all pass

### Step 2: Add a test pinning the caching contract

There is no test file for this module today — it is one of the untested
high-risk libs. Create `src/lib/asset-kiosks.test.ts` covering the caching
behaviour you must not break.

Build a stub `env` whose `ASSETS.fetch` returns canned JSON and **counts calls
per path**, so you can assert the fetch happened once. Model the stub style on
`src/lib/moderation.test.ts:42-61` (a minimal hand-rolled object cast to the
real type) — the codebase does not use a mocking framework for these.

Because the caches are module-scope, they persist across tests in one file. Use
distinct region slugs per test rather than trying to reset module state, and say
so in a comment.

Cases:

1. `getKioskById` returns the matching record for a known id.
2. Two calls to `kiosksByRegion` for the same slug fetch `/data/<slug>.geojson`
   exactly **once** (records cache works).
3. `kiosksByRegion` filters out `kind: "vending_machine"` features.
4. `getKioskById` returns `null` for an id whose prefix is not in the manifest.
5. `queryKiosksInBbox` returns only features inside the bbox and skips vending.

You will need a small manifest fixture (`/data/_manifest.json`) plus one or two
region fixtures. Keep them inline in the test file — two or three features each
is enough. `tests/e2e/fixtures/data/frankfurt.geojson` shows the real shape if
you need a reference.

**Verify**: `bun test src/lib/asset-kiosks.test.ts` → all pass.

### Step 3: Confirm the real data path still works

Unit tests use fixtures, so also exercise the module against the real built
dataset if one is present.

Check whether `dist/static/data/_manifest.json` exists. If it does, the previous
build's data is available and you can smoke-test against it. If it does not,
skip this step and note it in your report — `bun run build` clones the sibling
data repo and may not be runnable in your environment.

To smoke-test without a browser, run a short script that imports nothing from
the worker runtime: read `dist/static/data/_manifest.json`, pick the region with
the largest `count`, read that region file, and confirm it parses as a
FeatureCollection with that many features. This proves the on-disk contract the
module depends on is intact; the unit tests cover the module logic itself.

**Verify**: the script prints a feature count matching the manifest entry, or
you report that no built dataset was available.

### Step 4: Full suite

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test` → all pass; 114 + your new tests

## Test plan

- New file `src/lib/asset-kiosks.test.ts` with the five cases in Step 2. The
  load-bearing one is case 2: it pins that records are cached and the asset is
  fetched once, which is the behaviour that must survive removing the other
  cache.
- Structural pattern: `src/lib/moderation.test.ts` for the hand-rolled stub
  style and `describe`/`it` layout.
- Verification: `bun test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0, all tests passing
- [ ] `grep -n 'regionCache' src/lib/asset-kiosks.ts` returns no matches
- [ ] `grep -n 'regionRecordsCache' src/lib/asset-kiosks.ts` still returns
      matches (the records cache survives)
- [ ] `src/lib/asset-kiosks.test.ts` exists and includes the fetch-once assertion
- [ ] `git status --short` lists only `src/lib/asset-kiosks.ts` and
      `src/lib/asset-kiosks.test.ts` (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -rn 'loadRegion' src/lib/ src/routes/` shows a caller of the **server**
  `loadRegion` other than `recordsForRegion`. (`src/client/region-store.ts` has
  an unrelated function of the same name — that one is fine and out of scope.)
  A second caller means the raw cache has a real reader and this plan's premise
  is wrong.
- Removing the cache makes any existing test fail — report which and why.
- You find yourself needing to change `featureToRecord`, `queryKiosksInBbox`,
  `findNearbyKiosks`, or `findNearestKiosk` to make this work. This should be a
  deletion plus a test file, nothing more.

## Maintenance notes

- **The invariant**: `KioskRecord[]` is the only cached form of region data on
  the server. If a future feature needs a raw GeoJSON property that
  `featureToRecord` does not carry across, add the field to `KioskRecord`
  (`src/lib/db.ts:6-23`) and to `featureToRecord` — do **not** reintroduce a
  parallel raw cache. A reviewer should reject that specifically.
- Per the data repo's `AGENTS.md`, a new GeoJSON property must be mirrored in
  three places: the schema, the script's `Feature` interface, and this module's
  `Feature.properties` interface (`src/lib/asset-kiosks.ts:31-42`). That
  contract is unchanged by this plan.
- Still-open memory question, deliberately **out of scope**: with the raw cache
  gone, a full warm-up still retains ~14 MB of records. If the dataset grows
  substantially, the next lever is avoiding all-region loads in `countKiosks`
  (a build-time total in the manifest would do) and `findNearestKiosk` (a bbox
  pre-filter, as its own comment at `src/routes/api.kiosks.tsx:119-121` already
  anticipates). Both are real work with their own tradeoffs; neither belongs in
  a cache-removal change.
