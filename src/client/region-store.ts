/**
 * Client-side region data cache.
 *
 * Reads the static manifest + per-region GeoJSON files that the build step
 * (scripts/import-data.ts) drops into `/data/`. Replaces the `/api/kiosks?bbox=`
 * round-trip so the map's hot path no longer hits D1.
 *
 *   - Below DETAIL_ZOOM: one supercluster snapshot per integer zoom band
 *     (_summary_z5..z8.geojson). The map binds one snapshot per layer band.
 *   - At/above DETAIL_ZOOM: the union of per-region FeatureCollections whose
 *     bbox intersects the current viewport. Each region is fetched once and
 *     cached for the lifetime of the page.
 */

export type BBox = [number, number, number, number]; // [w, s, e, n]

export interface ManifestEntry {
  slug: string;
  prefix: string;
  bbox: BBox;
  count: number;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

export interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export const DETAIL_ZOOM = 9;
/** Integer zooms with a pre-baked summary snapshot. Kept in sync with
 *  SUMMARY_ZOOMS in scripts/import-data.ts. */
export const SUMMARY_ZOOMS = [5, 6, 7, 8] as const;
export type SummaryZoom = (typeof SUMMARY_ZOOMS)[number];

let manifestPromise: Promise<{ regions: ManifestEntry[] }> | null = null;
const summaryPromises = new Map<SummaryZoom, Promise<FeatureCollection>>();
const regionPromises = new Map<string, Promise<FeatureCollection>>();

const EMPTY_COLLECTION: FeatureCollection = { type: "FeatureCollection", features: [] };

export function loadManifest(): Promise<{ regions: ManifestEntry[] }> {
  manifestPromise ??= fetch("/data/_manifest.json", { headers: { accept: "application/json" } })
    .then((r) =>
      r.ok
        ? (r.json() as Promise<{ regions: ManifestEntry[] }>)
        : Promise.reject(new Error(`manifest ${r.status}`)),
    )
    .catch((err) => {
      manifestPromise = null;
      throw err;
    });
  return manifestPromise;
}

export function loadSummaryAtZoom(z: SummaryZoom): Promise<FeatureCollection> {
  let p = summaryPromises.get(z);
  if (!p) {
    p = fetch(`/data/_summary_z${z}.geojson`, { headers: { accept: "application/geo+json" } })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<FeatureCollection>)
          : Promise.reject(new Error(`summary_z${z} ${r.status}`)),
      )
      .catch((err) => {
        summaryPromises.delete(z);
        throw err;
      });
    summaryPromises.set(z, p);
  }
  return p;
}

import { classifyKind } from "../lib/kind";

export function loadRegion(slug: string): Promise<FeatureCollection> {
  let p = regionPromises.get(slug);
  if (!p) {
    p = fetch(`/data/${slug}.geojson`, { headers: { accept: "application/geo+json" } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`region ${slug} ${r.status}`);
        const c = (await r.json()) as FeatureCollection;
        for (const f of c.features) {
          const p = f.properties as { name?: string; kind?: string; _kind?: string };
          p._kind = classifyKind({ name: p.name, dataKind: p.kind });
        }
        return c;
      })
      .catch((err) => {
        regionPromises.delete(slug);
        throw err;
      });
    regionPromises.set(slug, p);
  }
  return p;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/** Slugs whose region bbox intersects the given viewport. */
export async function regionsForView(view: BBox): Promise<string[]> {
  const m = await loadManifest();
  return m.regions.filter((r) => bboxesOverlap(r.bbox, view)).map((r) => r.slug);
}

/**
 * Resolve the feature set that should populate the detail (clustered) source
 * for the current viewport. Union across all regions whose bbox intersects.
 * Pure vending-machine entries (classified by name regex in lib/kind.ts) are
 * dropped from the map view by default — deep links via /k/:id still load
 * them, they just don't surface on the map or sidebar.
 */
export async function detailFeaturesForView(view: BBox): Promise<FeatureCollection> {
  const slugs = await regionsForView(view);
  if (slugs.length === 0) return EMPTY_COLLECTION;
  const collections = await Promise.all(slugs.map(loadRegion));
  const features = collections
    .flatMap((c) => c.features)
    .filter((f) => (f.properties as { _kind?: string })._kind !== "vending");
  return { type: "FeatureCollection", features };
}
