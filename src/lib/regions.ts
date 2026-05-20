/**
 * Mirror of trinkhallen-data/regions.yml, embedded in the Worker so we can
 * resolve lat/lng → target GeoJSON file when approving a submission.
 *
 * Keep in sync with the data repo. If we expand to more regions, this file
 * grows; eventually we should generate it at build time from the YAML.
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
  {
    slug: "frankfurt",
    path: "data/de/hessen/frankfurt.geojson",
    prefix: "fr",
    bbox: [8.47, 50.01, 8.8, 50.23],
  },
];

export function resolveRegionByCoords(lng: number, lat: number): Region | null {
  return (
    REGIONS.find(
      (r) =>
        lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3],
    ) ?? null
  );
}

export function resolveRegionByPath(path: string): Region | null {
  return REGIONS.find((r) => r.path === path) ?? null;
}
