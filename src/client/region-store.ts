/**
 * Client-side region data cache.
 *
 * Reads the static manifest + per-region GeoJSON files that the build step
 * (scripts/import-data.ts) drops into `/data/`. Replaces the `/api/kiosks?bbox=`
 * round-trip so the map's hot path no longer hits D1.
 *
 *   - Below DETAIL_ZOOM: one Point per region (the low-zoom summary).
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

let manifestPromise: Promise<{ regions: ManifestEntry[] }> | null = null;
let summaryPromise: Promise<FeatureCollection> | null = null;
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

export function loadSummary(): Promise<FeatureCollection> {
  summaryPromise ??= fetch("/data/_summary.geojson", {
    headers: { accept: "application/geo+json" },
  })
    .then((r) =>
      r.ok
        ? (r.json() as Promise<FeatureCollection>)
        : Promise.reject(new Error(`summary ${r.status}`)),
    )
    .catch((err) => {
      summaryPromise = null;
      throw err;
    });
  return summaryPromise;
}

export function loadRegion(slug: string): Promise<FeatureCollection> {
  let p = regionPromises.get(slug);
  if (!p) {
    p = fetch(`/data/${slug}.geojson`, { headers: { accept: "application/geo+json" } })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<FeatureCollection>)
          : Promise.reject(new Error(`region ${slug} ${r.status}`)),
      )
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
 * Caller is responsible for swapping to the summary source at low zoom.
 */
export async function detailFeaturesForView(view: BBox): Promise<FeatureCollection> {
  const slugs = await regionsForView(view);
  if (slugs.length === 0) return EMPTY_COLLECTION;
  const collections = await Promise.all(slugs.map(loadRegion));
  return {
    type: "FeatureCollection",
    features: collections.flatMap((c) => c.features),
  };
}
