/**
 * Server-side accessor for the static kiosk data files produced by
 * scripts/import-data.ts. Replaces the D1 `kiosks` table.
 *
 * Two layers of caching keep this cheap:
 *   - Module-scope Maps live for the Worker isolate's lifetime, so cold-start
 *     fetches happen at most once per region per isolate.
 *   - `env.ASSETS.fetch` itself hits Cloudflare's edge cache before reaching
 *     the asset blob, so even the cold-start path is local.
 */

import type { Env } from "../env";
import type { KioskRecord } from "./db";
import { type Bbox, haversineMeters } from "./geo";
import { classifyKind } from "./kind";

interface ManifestEntry {
  slug: string;
  prefix: string;
  bbox: [number, number, number, number];
  count: number;
}

interface Manifest {
  regions: ManifestEntry[];
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address?: Record<string, string | undefined>;
    hours?: { raw: string };
    tags?: string[];
    payment?: Record<string, "yes" | "no" | "unknown">;
    sources?: Array<{ type: string; id: string; version?: number }>;
    kind?: "vending_machine";
    updated?: string;
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

let manifestCache: Manifest | null = null;
let prefixToSlug: Map<string, string> | null = null;
const regionCache = new Map<string, FeatureCollection>();
const regionRecordsCache = new Map<string, KioskRecord[]>();

async function fetchJson<T>(env: Env, path: string): Promise<T> {
  // The host doesn't matter for asset binding fetches — Workers Assets matches
  // on path only — but `new Request` requires a valid URL.
  const resp = await env.ASSETS.fetch(new Request(`https://assets.local${path}`));
  if (!resp.ok) throw new Error(`asset ${path} → HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

export async function loadManifest(env: Env): Promise<Manifest> {
  if (!manifestCache) {
    manifestCache = await fetchJson<Manifest>(env, "/data/_manifest.json");
    prefixToSlug = new Map(manifestCache.regions.map((r) => [r.prefix, r.slug]));
  }
  return manifestCache;
}

async function loadRegion(env: Env, slug: string): Promise<FeatureCollection> {
  let c = regionCache.get(slug);
  if (!c) {
    c = await fetchJson<FeatureCollection>(env, `/data/${slug}.geojson`);
    regionCache.set(slug, c);
  }
  return c;
}

function featureToRecord(slug: string, f: Feature): KioskRecord {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const updatedAt = p.updated ? Math.floor(Date.parse(p.updated) / 1000) || 0 : 0;
  const record: KioskRecord = {
    id: p.id,
    region: slug,
    name: p.name,
    address: (p.address ?? {}) as Record<string, string | undefined>,
    tags: p.tags ?? [],
    lng,
    lat,
    updatedAt,
    kind: classifyKind({ name: p.name, dataKind: p.kind }),
  };
  if (p.description) record.description = p.description;
  if (p.hours) record.hours = p.hours;
  if (p.payment) record.payment = p.payment;
  if (p.sources) record.sources = p.sources;
  return record;
}

/**
 * All non-vending kiosks in the named region. Exposed for the per-city
 * landing pages (/stadt/:slug). Returns an empty array if the region
 * isn't in the manifest.
 */
export async function kiosksByRegion(env: Env, slug: string): Promise<KioskRecord[]> {
  const manifest = await loadManifest(env);
  if (!manifest.regions.some((r) => r.slug === slug)) return [];
  const records = await recordsForRegion(env, slug);
  return records.filter((r) => r.kind !== "vending");
}

async function recordsForRegion(env: Env, slug: string): Promise<KioskRecord[]> {
  let rs = regionRecordsCache.get(slug);
  if (!rs) {
    const collection = await loadRegion(env, slug);
    rs = collection.features.map((f) => featureToRecord(slug, f));
    regionRecordsCache.set(slug, rs);
  }
  return rs;
}

function parsePrefix(id: string): string | null {
  // tk_<prefix>_<rest> — the prefix is the segment between the first two
  // underscores. User submissions and OSM rows both follow this layout.
  const m = id.match(/^tk_([a-z0-9]+)_/i);
  return m?.[1] ? m[1] : null;
}

function bboxesOverlap(
  a: [number, number, number, number],
  b: { west: number; south: number; east: number; north: number },
): boolean {
  return !(a[2] < b.west || a[0] > b.east || a[3] < b.south || a[1] > b.north);
}

export async function getKioskById(env: Env, id: string): Promise<KioskRecord | null> {
  await loadManifest(env);
  const prefix = parsePrefix(id);
  if (!prefix) return null;
  const slug = prefixToSlug?.get(prefix);
  if (!slug) return null;
  const records = await recordsForRegion(env, slug);
  return records.find((r) => r.id === id) ?? null;
}

export async function queryKiosksInBbox(
  env: Env,
  bbox: Bbox,
  limit = 5000,
): Promise<KioskRecord[]> {
  const manifest = await loadManifest(env);
  const slugs = manifest.regions.filter((r) => bboxesOverlap(r.bbox, bbox)).map((r) => r.slug);

  const collections = await Promise.all(slugs.map((s) => recordsForRegion(env, s)));
  const out: KioskRecord[] = [];
  for (const records of collections) {
    for (const r of records) {
      if (r.kind === "vending") continue; // not surfaced in collection views
      if (r.lng >= bbox.west && r.lng <= bbox.east && r.lat >= bbox.south && r.lat <= bbox.north) {
        out.push(r);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export async function countKiosks(env: Env): Promise<number> {
  // Count from the loaded region records (not the manifest sum) so the figure
  // matches what users actually see — vending-only entries are excluded.
  const manifest = await loadManifest(env);
  const all = await Promise.all(manifest.regions.map((r) => recordsForRegion(env, r.slug)));
  let n = 0;
  for (const rs of all) for (const r of rs) if (r.kind !== "vending") n++;
  return n;
}

/**
 * The N closest kiosks to `origin`, excluding the feature with `excludeId`
 * (used by /k/:id to render "in der Nähe"). Loads the region whose bbox
 * contains the origin first, then expands to neighbours if it can't fill
 * the limit — avoids touching every region for short-range queries.
 */
export async function findNearbyKiosks(
  env: Env,
  origin: { lat: number; lng: number },
  excludeId: string,
  limit = 5,
): Promise<Array<{ record: KioskRecord; distance: number }>> {
  const manifest = await loadManifest(env);
  // Pad the lookup bbox so we always have neighbours to compare against,
  // even if the origin sits at the very edge of its region. ~5 km in
  // longitude at German latitudes.
  const slugs = manifest.regions
    .filter(
      (r) =>
        r.bbox[0] - 0.05 <= origin.lng &&
        r.bbox[2] + 0.05 >= origin.lng &&
        r.bbox[1] - 0.05 <= origin.lat &&
        r.bbox[3] + 0.05 >= origin.lat,
    )
    .map((r) => r.slug);
  const collections = await Promise.all(slugs.map((s) => recordsForRegion(env, s)));
  const ranked: Array<{ record: KioskRecord; distance: number }> = [];
  for (const records of collections) {
    for (const r of records) {
      if (r.kind === "vending") continue;
      if (r.id === excludeId) continue;
      const d = haversineMeters(origin, { lat: r.lat, lng: r.lng });
      ranked.push({ record: r, distance: d });
    }
  }
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked.slice(0, limit);
}

/**
 * Closest kiosk to `origin` across the whole dataset. Loads every region file
 * once (cached for the isolate lifetime). For ~12 k features this is on the
 * order of a few ms after the first call.
 */
export async function findNearestKiosk(
  env: Env,
  origin: { lat: number; lng: number },
): Promise<{ record: KioskRecord; distance: number } | null> {
  const manifest = await loadManifest(env);
  const all = await Promise.all(manifest.regions.map((r) => recordsForRegion(env, r.slug)));
  let best: KioskRecord | null = null;
  let bestDist = Infinity;
  for (const records of all) {
    for (const r of records) {
      if (r.kind === "vending") continue; // never recommend an automat as "nearest"
      const d = haversineMeters(origin, { lat: r.lat, lng: r.lng });
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
  }
  return best ? { record: best, distance: bestDist } : null;
}
