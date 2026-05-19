/**
 * Geo helpers for bbox parsing, quantization (for cache keys), and the integer
 * hash used as the rtree primary key (D1 / SQLite rtree requires an integer id).
 */

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function parseBbox(raw: string | null | undefined): Bbox | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => parseFloat(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

/** Round bbox edges to a grid so adjacent pans produce identical cache keys. */
export function quantizeBbox(b: Bbox, step = 0.01): Bbox {
  const round = (n: number) => Math.round(n / step) * step;
  return {
    west: round(b.west),
    south: round(b.south),
    east: round(b.east),
    north: round(b.north),
  };
}

