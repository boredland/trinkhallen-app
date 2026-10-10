# Plan 009: Generate the region table from `regions.yml` instead of hand-copying it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- src/lib/regions.ts src/lib/regions.test.ts src/lib/regions.generated.ts scripts/import-data.ts package.json biome.json src/components/KioskDetail.tsx AGENTS.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / tech-debt
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

Kiosk data lives in the sibling repo `trinkhallen-data`, whose `regions.yml`
lists every region (slug, data-file path, ID prefix, bbox). This app keeps a
**hand-copied** mirror in `src/lib/regions.ts`, last edited 2026-05-25. The data
repo has since grown from 47 to 74 regions (Bundesland "rest" buckets plus
Austria, Switzerland, Liechtenstein, Luxembourg, South Tyrol, East Belgium) and
renamed Freiburg's prefix from `fr-bw` to `frb`.

Measured against today's data: **6,358 of 18,018 kiosks (35%) live in regions
the app does not know.** Consequences, all in moderation:

- A user-submitted kiosk outside the 47 city boxes is auto-**dismissed** as "region
  not yet covered" (`src/lib/moderation.ts:78-89`), although the data repo does
  cover it.
- A correction report for any of those 6,358 kiosks opens a GitHub **issue**
  for manual work instead of a ready-to-merge PR (`moderation.ts:261-264`).
- An approved Freiburg submission is minted as `tk_fr-bw_<id>`. The kiosk-ID
  parser only accepts `[a-z0-9]` prefixes (`src/lib/asset-kiosks.ts:124`), so
  that kiosk's detail page would 404.
- Public-holiday-aware opening hours are silently off for kiosks in the German
  rest buckets (`getBundeslandForRegion` returns `null`).

There is a second, subtler defect. Today `resolveRegionByCoords` returns the
**first** region in array order whose bbox contains the point. City bboxes
overlap, so 943 kiosks resolve to a different file than the one they live in
(e.g. 268 Mainz kiosks resolve to `frankfurt`, 393 Düsseldorf kiosks to `ruhr`).
The data repo assigns points with a different rule (`ownsFeature`, below), which
agrees with the actual file for 17,609 of 17,794 kiosks. Adding the 27 missing
regions without also adopting that rule would put new submissions into the wrong
file.

After this plan, the build generates the table from `regions.yml`, and
coordinate resolution uses the data repo's own ownership rule.

## Current state

### The hand-written mirror — `src/lib/regions.ts` (360 lines)

```ts
/**
 * Mirror of trinkhallen-data/regions.yml, embedded in the Worker so we can
 * resolve a kiosk's region slug → target GeoJSON file path when approving a
 * report or submission.
 *
 * Keep in sync with the data repo. The build pipeline doesn't auto-generate
 * this yet; the asset manifest (`/data/_manifest.json`) carries slug/prefix
 * /bbox/count but not `path`, which is what moderation needs to open a PR
 * at the right file. Worth promoting to build-time codegen once it grows.
 */

export interface Region {
  slug: string;
  /** Path relative to repo root, e.g. data/de/hessen/frankfurt.geojson */
  path: string;
  /** ID prefix used when minting new feature ids, e.g. "fr" → tk_fr_xxxx */
  prefix: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

export const REGIONS: Region[] = [
  { slug: "frankfurt", path: "data/de/hessen/frankfurt.geojson", prefix: "fr", bbox: [7.9, 49.84, 9.48, 50.61] },
  // … 46 more city entries, lines 22-305; Freiburg at 102-106 has prefix: "fr-bw"
];

export function resolveRegionByCoords(lng: number, lat: number): Region | null {   // line 307
  return (
    REGIONS.find(
      (r) => lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3],
    ) ?? null
  );
}

export function resolveRegionByPath(path: string): Region | null {                 // line 315
  return REGIONS.find((r) => r.path === path) ?? null;
}

export function resolveRegionBySlug(slug: string): Region | null {                 // line 319
  return REGIONS.find((r) => r.slug === slug) ?? null;
}

const BUNDESLAND_BY_SLUG: Record<string, string> = { "baden-wuerttemberg": "Baden-Württemberg", /* … 16 German states */ };

export function getBundeslandForRegion(regionSlug: string): string | null {         // line 353
  const region = resolveRegionBySlug(regionSlug);
  if (!region) return null;
  const segments = region.path.split("/");
  const bundeslandSlug = segments[2];
  if (!bundeslandSlug) return null;
  return BUNDESLAND_BY_SLUG[bundeslandSlug] ?? null;
}
```

Consumers (do not change their call signatures):

- `src/lib/moderation.ts:78` `resolveRegionByCoords(lng, lat)` — places an
  approved submission; `:94` mints `tk_${region.prefix}_${shortId}`.
- `src/lib/moderation.ts:261` `resolveRegionBySlug(kiosk.region)` — finds the
  file to patch for a report.
- `src/lib/opening-hours.ts:51` and `src/client/client-filters.ts:44-46` —
  `getBundeslandForRegion` for public-holiday evaluation. **The client bundle
  imports this module**, so the table ships to browsers too (74 small entries;
  fine).
- `src/components/KioskDetail.tsx:354` builds the "edit on GitHub" link as
  `` `https://github.com/boredland/trinkhallen-data/blob/main/data/${kiosk.region}.geojson` ``.
  `kiosk.region` is a **slug** (e.g. `frankfurt`), so the link is
  `…/data/frankfurt.geojson`, which returns 404 on GitHub (verified). The real
  path is `data/de/hessen/frankfurt.geojson`. This plan fixes the link because
  the full table makes it a one-liner.

### The source of truth — `../trinkhallen-data/regions.yml`

74 entries; keys `slug, path, prefix, iso3166_2, admin_level, bbox`, plus
`role: rest` on the 27 rest buckets (absent = city) and `bbox_clip` on one.
Paths include `data/de/hessen/_rest.geojson`, `data/at/wien/_rest.geojson`,
`data/ch/_rest.geojson`. Every prefix matches `^[a-z0-9]+$` and all 74 are
unique. All bboxes fall inside `w ≥ 5.73, e ≤ 17.16, s ≥ 45.81, n ≤ 55.06`.

### The data repo's ownership rule — `../trinkhallen-data/scripts/osm-to-geojson.ts:65-109`

```ts
function bboxCenter(r: Region): [number, number] {
  const [w, s, e, n] = r.bbox;
  return [(w + e) / 2, (s + n) / 2];
}
function bboxContains(r: Region, lng: number, lat: number): boolean {
  const [w, s, e, n] = r.bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}
function squaredAnchorDistance(r: Region, lng: number, lat: number): number {
  const [cLng, cLat] = bboxCenter(r);
  const dLng = (lng - cLng) * Math.cos((lat * Math.PI) / 180);
  const dLat = lat - cLat;
  return dLng * dLng + dLat * dLat;
}
/**
 * A point belongs to exactly one region. Resolution order:
 *   1. City regions whose bbox contains the point — nearest anchor wins.
 *   2. Rest regions whose bbox contains the point — nearest anchor wins.
 * A city region always beats any rest region …
 */
export function ownsFeature(region: Region, allRegions: Region[], lng: number, lat: number): boolean {
  const candidates = allRegions.filter((r) => bboxContains(r, lng, lat));
  if (candidates.length === 0) return true;
  const cities = candidates.filter((r) => (r.role ?? "city") === "city");
  const pool = cities.length > 0 ? cities : candidates;
  let best = pool[0]!;
  let bestD = squaredAnchorDistance(best, lng, lat);
  for (let i = 1; i < pool.length; i++) {
    const d = squaredAnchorDistance(pool[i]!, lng, lat);
    if (d < bestD) { best = pool[i]!; bestD = d; }
  }
  return best.slug === region.slug;
}
```

The app must return `null` when no bbox contains the point (the data repo's
"defensive true" does not apply here).

### The build — `package.json:10` and `scripts/import-data.ts`

```json
"build": "vite build --mode client && bun scripts/write-asset-manifest.ts && bun scripts/import-data.ts && vite build",
```

`scripts/import-data.ts` already parses `regions.yml` (`loadRegions`, lines
115-119) from either `TRINKHALLEN_DATA_PATH` or a fresh shallow clone into
`.tmp/trinkhallen-data`. Its local `Region` interface (lines 69-76) lacks
`role`. It writes `dist/static/data/*` and `dist/static/sitemap.xml`; it does
not depend on any client-build output.

**Ordering problem**: the client bundle is built *before* `import-data.ts`
runs, so anything `import-data.ts` generates would reach the Worker bundle but
not the client bundle. The plan moves `import-data.ts` to the front.

### Codegen exemplar to copy — `scripts/write-asset-manifest.ts`

It writes `src/lib/manifest.generated.ts` with this header and shape, and that
generated file **is committed** (tracked in git, regenerated on every build, and
excluded from biome in `biome.json:16`):

```ts
const body = `/* Auto-generated by scripts/write-asset-manifest.ts. Do not edit by hand. */
export const manifest: Record<string, { file: string; css?: string[] }> = ${JSON.stringify(slim, null, 2)};
`;
writeFileSync(TARGET, body);
console.log(`Wrote ${Object.keys(slim).length} manifest entries → ${TARGET}`);
```

Commit `src/lib/regions.generated.ts` the same way. `bun test` and the
pre-commit `tsc` run without a data checkout, so they need the committed copy.
Production builds regenerate it, so the deployed Worker and client always match
`regions.yml`.

### Existing tests — `src/lib/regions.test.ts` (67 lines)

They pin Germany-only shapes that become wrong: line 44
`expect(r.path).toMatch(/^data\/de\/[a-z-]+\/[a-z][a-z0-9-]+\.geojson$/)` and
lines 51-54 bbox bounds `w > 5, e < 16, s > 47, n < 56`. `src/lib/moderation.test.ts`
uses `region: "frankfurt"` and a fake `"atlantis"` slug; both stay valid.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Generate  | `TRINKHALLEN_DATA_PATH=../trinkhallen-data bun scripts/import-data.ts` | ends with `Done. 74 regions, … features` and a `Wrote 74 regions →` line |
| Typecheck | `bun run typecheck` | exit 0 |
| Focused   | `bun test src/lib/regions.test.ts src/lib/moderation.test.ts` | all pass |
| Tests     | `bun test` | all pass |
| Lint      | `bun run lint` | exit 0 |

If `../trinkhallen-data` is absent, omit `TRINKHALLEN_DATA_PATH`; the script
then shallow-clones the public repo into `.tmp/` (gitignored, needs network).

## Scope

**In scope** (the only files you should modify):

- `scripts/import-data.ts` — emit the generated table
- `src/lib/regions.generated.ts` (create, committed, generated)
- `src/lib/regions.ts` — drop the hand-written array, import the generated one,
  new coordinate rule, guard the Bundesland lookup to `data/de/`
- `src/lib/regions.test.ts` — update shape tests, add resolution tests
- `package.json` — reorder the `build` script only
- `biome.json` — add the generated file to the ignore list
- `src/components/KioskDetail.tsx` — the GitHub source link only (line 354)
- `AGENTS.md` — one hot-spot bullet

**Out of scope** (do NOT touch):

- `../trinkhallen-data/**` — read only. Never edit the data repo.
- `src/lib/moderation.ts` — its calls stay the same; behaviour changes only
  because the table and the resolver improve.
- `src/lib/asset-kiosks.ts` — it uses the runtime manifest, not this table.
- `src/lib/checkins.ts` `regionSlugFromPath` and `pages.tsx` `citySlug` — they
  split a slug that is already a slug; harmless, separate cleanup.
- Austrian/Swiss public holidays. `opening-hours.ts:38` hardcodes
  `country_code: "de"`; non-German regions must keep returning `null` from
  `getBundeslandForRegion` (evaluate without holidays rather than with wrong
  ones).
- The `/stadt/<slug>` pages and the sitemap.

## Git workflow

- Branch: `advisor/009-generate-regions-table`
- Two commits:
  1. `build(regions): generate the region table from regions.yml` (Steps 1-4)
  2. `fix(kiosk): link the real data file on GitHub` (Step 6)
- Do NOT push or open a PR.

## Steps

### Step 1: Emit `src/lib/regions.generated.ts` from `import-data.ts`

In `scripts/import-data.ts`:

1. Add `role?: "rest";` to the local `Region` interface (lines 69-76).
2. Add a function that writes the table from **all** regions in the YAML (do
   not skip regions whose data file is missing; the table describes the repo,
   not the bundle). Write only `slug`, `path`, `prefix`, `bbox`, `role`
   (default `"city"`):

```ts
const REGIONS_TS = resolve("src/lib/regions.generated.ts");

/**
 * Moderation needs each region's data-file path, which the asset manifest
 * doesn't carry, and the app must resolve coordinates with the same table the
 * data repo uses. Generating it here keeps the two from drifting; the file is
 * committed so tests and typechecks work without a data checkout.
 */
function writeRegionsModule(regions: Region[]): void {
  const rows = regions.map((r) => ({
    slug: r.slug,
    path: r.path,
    prefix: r.prefix,
    bbox: r.bbox,
    role: r.role ?? "city",
  }));
  const body = `/* Auto-generated by scripts/import-data.ts from trinkhallen-data/regions.yml. Do not edit by hand. */
import type { Region } from "./regions";

export const REGIONS: Region[] = ${JSON.stringify(rows, null, 2)};
`;
  writeFileSync(REGIONS_TS, body);
  console.log(`  Wrote ${rows.length} regions → ${REGIONS_TS}`);
}
```

3. Call `writeRegionsModule(regions)` in `main()` right after
   `const regions = loadRegions(src);` (line 124), before any data copying, so
   a later failure still leaves a consistent table.
4. Fail the build on a prefix the kiosk-ID parser can't read — this is exactly
   the Freiburg bug class. Inside `writeRegionsModule`, before writing:

```ts
  const bad = regions.filter((r) => !/^[a-z0-9]+$/.test(r.prefix));
  if (bad.length) {
    throw new Error(`regions.yml prefixes must match [a-z0-9]+ (tk_<prefix>_…): ${bad.map((r) => r.prefix).join(", ")}`);
  }
```

**Verify**: run the Generate command → output includes `Wrote 74 regions →`;
`grep -c '"slug"' src/lib/regions.generated.ts` → `74`;
`grep -n 'fr-bw' src/lib/regions.generated.ts` → no match;
`grep -n '"frb"' src/lib/regions.generated.ts` → one match.

### Step 2: Switch `regions.ts` to the generated table and the ownership rule

In `src/lib/regions.ts`:

1. Add `role: "city" | "rest";` to `Region` with a short doc comment.
2. Delete the `REGIONS` array (lines 22-305). Add
   `import { REGIONS } from "./regions.generated";` and
   `export { REGIONS };` so `regions.test.ts`'s existing `REGIONS` import keeps
   working.
   - The generated file imports `type Region` from this module and this module
     imports a value from it. A type-only import is erased at compile time, so
     there is no runtime cycle. If `tsc` or biome objects anyway, move
     `Region` into the generated file's header instead and re-export it — but
     report that you had to.
3. Replace `resolveRegionByCoords` with a port of `ownsFeature`'s selection,
   returning the region instead of a boolean and `null` when nothing contains
   the point. Keep the three helper functions private. Write a comment that
   says *why*: the data repo places points with this rule, so a submission must
   use it too or it lands in a different file than the scraper would choose.
4. Rewrite the module header: the table is generated by
   `scripts/import-data.ts`; edit `regions.yml` in the data repo, not this file.
5. Guard `getBundeslandForRegion` to German paths: return `null` unless
   `segments[1] === "de"`. (Today an Austrian path like
   `data/at/wien/_rest.geojson` happens to yield `null` only because `wien`
   isn't in the map; make that explicit.)

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Update and extend `regions.test.ts`

1. Line 44 path regex → `/^data\/[a-z]{2}\/(?:[a-z-]+\/)?[a-z_][a-z0-9_-]*\.geojson$/`.
2. Lines 51-54 bbox bounds → `w > 5, e < 18, s > 45, n < 56` and change the
   comment to "plausible DACH + neighbours".
3. Add `it("prefixes are parseable by asset-kiosks' tk_<prefix>_ parser and unique")`:
   every `prefix` matches `/^[a-z0-9]+$/`; `new Set(prefixes).size === REGIONS.length`.
4. Add `it("contains at least one rest region")` asserting some entry has
   `role === "rest"` (guards against a generator that drops `role`).
5. Add a `describe("resolveRegionByCoords — data-repo ownership rule")` with:
   - `(8.68, 50.11)` → `frankfurt`
   - `(8.24, 50.08)` (Wiesbaden/Mainz area, inside both the frankfurt and
     mainz bboxes) → `mainz` (nearest anchor wins; first-match would say
     `frankfurt`)
   - `(9.0, 50.8)` (rural Hessen, outside every city bbox) → `hessen-rest`
   - `(16.37, 48.21)` (Vienna) → `wien-rest`
   - `(8.54, 47.37)` (Zürich) → `schweiz-rest`
   - `(-30, 30)` → `null`
6. Add `describe("getBundeslandForRegion")`: `frankfurt` → `"Hessen"`,
   `hessen-rest` → `"Hessen"`, `wien-rest` → `null`, `schweiz-rest` → `null`,
   `atlantis` → `null`.

Before finalizing case 5, confirm each expectation against the generated table
with a throwaway one-liner, e.g.
`bun -e 'import { resolveRegionByCoords as r } from "./src/lib/regions"; console.log(r(8.24, 50.08)?.slug)'`.
If any expectation differs, STOP (the table differs from what this plan saw).

**Verify**: `bun test src/lib/regions.test.ts src/lib/moderation.test.ts` →
all pass.

### Step 4: Make the build generate before bundling; lint config

1. `package.json` `build` script → move `bun scripts/import-data.ts` to the
   front:
   `"build": "bun scripts/import-data.ts && vite build --mode client && bun scripts/write-asset-manifest.ts && vite build",`
   (Leave `build:data` as is.)
2. `biome.json` `files.includes` → add `"!src/lib/regions.generated.ts",` next to
   the existing `"!src/lib/manifest.generated.ts",` line.

**Verify**:
- `TRINKHALLEN_DATA_PATH=../trinkhallen-data bun run build` → exit 0; the
  log shows `Wrote 74 regions` **before** the first `vite build` output.
- After the build, `git status --short src/lib/regions.generated.ts` shows no
  change compared with your Step 1 output (deterministic generation).
- `bun run lint` → exit 0.
- `grep -o 'hessen-rest' dist/static/assets/app-*.js | head -1` → prints
  `hessen-rest` (the client bundle got the full table).

### Step 5: Full suite

**Verify**: `bun run typecheck` → exit 0; `bun test` → all pass;
`bun run lint` → exit 0. Commit (commit 1).

### Step 6: Fix the "edit on GitHub" link

In `src/components/KioskDetail.tsx:354`, build the href from the region's real
path: import `resolveRegionBySlug` from `../lib/regions` and use
`` `https://github.com/boredland/trinkhallen-data/blob/main/${resolveRegionBySlug(kiosk.region)?.path ?? "regions.yml"}` ``
(falling back to the repo's `regions.yml` keeps the link valid for an unknown
slug rather than pointing at a 404).

**Verify**: `bun run typecheck` → exit 0; `bun test` → all pass. With
`bun run dev` running against a local build, open any `/k/<id>` page; the footer
link points at a `…/blob/main/data/de/<land>/<slug>.geojson` URL. Run
`curl -s -o /dev/null -w '%{http_code}\n' <that URL>` → `200`. Commit (commit 2).

### Step 7: Document the hot spot

Add one bullet to `AGENTS.md` under "## Hot spots":

```md
- **`src/lib/regions.generated.ts`** is written by `scripts/import-data.ts`
  from the data repo's `regions.yml` on every build (committed so tests run
  without a data checkout). Never hand-edit it; change `regions.yml`.
  `resolveRegionByCoords` mirrors the data repo's `ownsFeature` rule (city
  beats rest, nearest bbox centre wins) — keep them in step.
```

**Verify**: `grep -n 'regions.generated.ts' AGENTS.md` → one match. Amend into
commit 1 or add as a third commit `docs(agents): note the generated region table`.

## Test plan

- Updated shape tests in `src/lib/regions.test.ts` (non-German paths, wider
  bbox envelope).
- New invariants: parseable unique prefixes (catches the Freiburg class),
  presence of rest regions.
- New resolution tests encoding the ownership rule, including the Mainz case
  where first-match and nearest-anchor disagree.
- New `getBundeslandForRegion` cases for rest and foreign regions.
- Pattern: the existing `describe` blocks in `src/lib/regions.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0; `bun run lint` exits 0; `bun test` exits 0
- [ ] `grep -c '"slug"' src/lib/regions.generated.ts` prints `74`
- [ ] `grep -rn 'fr-bw' src/` returns no matches
- [ ] `grep -c 'slug: "' src/lib/regions.ts` prints `0` (hand-written array gone)
- [ ] `bun -e 'import { resolveRegionByCoords as r } from "./src/lib/regions"; console.log(r(8.24,50.08)?.slug, r(9.0,50.8)?.slug, r(16.37,48.21)?.slug)'`
      prints `mainz hessen-rest wien-rest`
- [ ] The `build` script in `package.json` starts with `bun scripts/import-data.ts &&`
- [ ] `git status --short` lists only in-scope files (plus `plans/README.md`)
- [ ] Mutation check: change one prefix in `src/lib/regions.generated.ts` to
      `"fr-bw"` → the prefix test fails; revert. Change `resolveRegionByCoords`
      back to first-match → the Mainz test fails; revert. Report both.
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `regions.yml` no longer has 74 entries, a prefix fails `^[a-z0-9]+$`, or a
  key named in this plan (`role`, `path`, `prefix`, `bbox`) is missing or renamed.
- `ownsFeature` in `../trinkhallen-data/scripts/osm-to-geojson.ts` no longer
  matches the excerpt above (the rule changed; port the new one only after
  reporting).
- Reordering the build breaks it (e.g. `vite build --mode client` wipes
  `dist/static/data` — it should not, `emptyOutDir` is `false` in
  `vite.config.ts:18`).
- Any existing test outside `regions.test.ts` fails after Step 2. In particular,
  if a `moderation.test.ts` case starts dismissing or mis-placing a submission,
  report the case; do not edit that test.
- The generated file differs between two consecutive generator runs.

## Maintenance notes

- **Invariant**: the app resolves coordinates exactly as the data repo assigns
  them. If `ownsFeature` changes, `resolveRegionByCoords` must change in the
  same way — the AGENTS.md bullet says so, and a reviewer of any data-repo
  change to `ownsFeature` should open a matching app change.
- The committed `regions.generated.ts` can lag `regions.yml` between local
  builds; production is always fresh because the Cloudflare build runs
  `import-data.ts` first. A stale committed copy only affects local tests and
  dev. Regenerating shows up as a diff in `git status`, the same as
  `manifest.generated.ts` today — commit it.
- 185 kiosks (1%) sit in a file that the ownership rule would not choose
  (mostly legacy non-OSM entries). This only matters for **reports** if the
  data repo moves them; reports resolve by slug (`kiosk.region`, from the file
  the kiosk is actually in), not by coordinates, so they are unaffected.
- Follow-up not in this plan: public-holiday support for AT/CH/LU/IT/BE needs a
  per-country `country_code` in `opening-hours.ts`.
