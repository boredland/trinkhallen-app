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

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in meters using the haversine formula. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371008.8; // IUGG mean Earth radius in meters
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "230 m", "1.2 km", "12 km" — German-style spaces, fixed decimals. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

export function parseLatLng(raw: string | null | undefined): LatLng | null {
  if (!raw) return null;
  const [lat, lng] = raw.split(",").map((s) => parseFloat(s));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat! < -90 ||
    lat! > 90 ||
    lng! < -180 ||
    lng! > 180
  ) {
    return null;
  }
  return { lat: lat!, lng: lng! };
}

/**
 * A small box around a point, used to seed the SSR side-panel for a focused
 * kiosk or a `?c=lat,lng` deep link. The ~±0.05°/±0.04° padding mirrors the
 * initial viewport map.entry.ts opens around a centre.
 */
export function bboxAround(p: LatLng): Bbox {
  return { west: p.lng - 0.05, south: p.lat - 0.04, east: p.lng + 0.05, north: p.lat + 0.04 };
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
