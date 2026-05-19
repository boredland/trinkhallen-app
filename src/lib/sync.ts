/**
 * Upserts a GeoJSON FeatureCollection from trinkhallen-data into D1.
 *
 * Called by the /api/sync webhook handler (after diffing the push payload to
 * find changed data/**.geojson files) and by the local seed script.
 */

export type TriState = "yes" | "no" | "unknown";

export interface KioskFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address: Record<string, string | undefined>;
    hours?: { raw: string };
    tags?: string[];
    payment?: Record<string, TriState>;
    sources?: Array<{ type: string; id: string; version?: number }>;
    updated?: string;
  };
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: KioskFeature[];
}

export interface SyncStats {
  upserted: number;
  deleted: number;
  region: string;
}

/**
 * Replace all kiosks in a region with the given FeatureCollection. We treat
 * each GeoJSON file as authoritative for its region: anything not in the file
 * is deleted. This matches the "GitHub repo is the source of truth" model.
 */
export async function syncRegion(
  db: D1Database,
  region: string,
  collection: FeatureCollection,
): Promise<SyncStats> {
  const now = Math.floor(Date.now() / 1000);
  const incomingIds = new Set(collection.features.map((f) => f.properties.id));

  const existing = await db
    .prepare("SELECT id FROM kiosks WHERE region = ?")
    .bind(region)
    .all<{ id: string }>();
  const toDelete = existing.results.map((r) => r.id).filter((id) => !incomingIds.has(id));

  const stmts: D1PreparedStatement[] = [];

  for (const id of toDelete) {
    stmts.push(db.prepare("DELETE FROM kiosks WHERE id = ?").bind(id));
  }

  for (const f of collection.features) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;

    stmts.push(
      db
        .prepare(
          `INSERT INTO kiosks (id, region, name, description, address_json, hours_raw, tags_json, payment_json, lng, lat, sources_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             region = excluded.region,
             name = excluded.name,
             description = excluded.description,
             address_json = excluded.address_json,
             hours_raw = excluded.hours_raw,
             tags_json = excluded.tags_json,
             payment_json = excluded.payment_json,
             lng = excluded.lng,
             lat = excluded.lat,
             sources_json = excluded.sources_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          p.id,
          region,
          p.name,
          p.description ?? null,
          JSON.stringify(p.address),
          p.hours?.raw ?? null,
          JSON.stringify(p.tags ?? []),
          p.payment ? JSON.stringify(p.payment) : null,
          lng,
          lat,
          p.sources ? JSON.stringify(p.sources) : null,
          now,
        ),
    );
  }

  await db.batch(stmts);

  return { upserted: collection.features.length, deleted: toDelete.length, region };
}

/** Derive a region slug from a data file path: `data/de/hessen/frankfurt.geojson` → `de/hessen/frankfurt`. */
export function regionFromPath(path: string): string | null {
  const m = path.match(/^data\/(.+)\.geojson$/);
  return m && m[1] ? m[1] : null;
}
