import type { Bbox } from "./geo";

/**
 * Database row shapes mirror the schema in migrations/0001_init.sql.
 * Stringified JSON columns are typed loosely here; parse at the use site.
 */

export interface KioskRow {
  id: string;
  region: string;
  name: string;
  description: string | null;
  address_json: string;
  hours_raw: string | null;
  tags_json: string;
  payment_json: string | null;
  lng: number;
  lat: number;
  sources_json: string | null;
  updated_at: number;
}

export interface KioskRecord {
  id: string;
  region: string;
  name: string;
  description?: string;
  address: Record<string, string | undefined>;
  hours?: { raw: string };
  tags: string[];
  payment?: Record<string, "yes" | "no" | "unknown">;
  lng: number;
  lat: number;
  sources?: Array<{ type: string; id: string; version?: number }>;
  updatedAt: number;
}

export function rowToRecord(row: KioskRow): KioskRecord {
  return {
    id: row.id,
    region: row.region,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    address: JSON.parse(row.address_json),
    ...(row.hours_raw ? { hours: { raw: row.hours_raw } } : {}),
    tags: JSON.parse(row.tags_json),
    ...(row.payment_json ? { payment: JSON.parse(row.payment_json) } : {}),
    lng: row.lng,
    lat: row.lat,
    ...(row.sources_json ? { sources: JSON.parse(row.sources_json) } : {}),
    updatedAt: row.updated_at,
  };
}

/**
 * Bbox query — straight WHERE-scan against the (lng, lat) composite index.
 * Cap the result count so a runaway pan can't OOM a Worker; the client
 * smooths over the cap via clustering.
 */
export async function queryKiosksInBbox(
  db: D1Database,
  bbox: Bbox,
  limit = 5000,
): Promise<KioskRecord[]> {
  const stmt = db.prepare(`
    SELECT *
    FROM kiosks
    WHERE lng >= ? AND lng <= ?
      AND lat >= ? AND lat <= ?
    LIMIT ?
  `);
  const { results } = await stmt
    .bind(bbox.west, bbox.east, bbox.south, bbox.north, limit)
    .all<KioskRow>();
  return results.map(rowToRecord);
}

export async function getKioskById(db: D1Database, id: string): Promise<KioskRecord | null> {
  const row = await db.prepare("SELECT * FROM kiosks WHERE id = ?").bind(id).first<KioskRow>();
  return row ? rowToRecord(row) : null;
}

/**
 * Whole-dataset query for the /list page. No bbox; pages through alphabetical
 * order. Filters apply post-fetch in JS, so we pull a generous batch.
 */
export async function queryKiosksAll(
  db: D1Database,
  limit = 5000,
): Promise<KioskRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM kiosks ORDER BY name COLLATE NOCASE LIMIT ?")
    .bind(limit)
    .all<KioskRow>();
  return results.map(rowToRecord);
}

export async function countKiosks(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM kiosks").first<{ n: number }>();
  return row?.n ?? 0;
}
